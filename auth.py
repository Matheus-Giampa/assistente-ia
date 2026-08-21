import asyncio
import logging
import secrets
import time
from datetime import datetime, timedelta, timezone
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import bcrypt
import jwt

from config import get_settings
from database import acquire_connection

logger = logging.getLogger(__name__)

settings = get_settings()

# Hash fixo (nunca usado como senha de verdade por ninguem) so pra ter algo
# valido pra comparar quando o email nao existe -- ver authenticate() abaixo,
# isso equaliza o tempo de resposta entre "email nao existe" e "senha errada"
# (achado real de pentest: sem isso da pra medir ~1s de diferenca e descobrir
# quais emails tem conta so cronometrando a resposta).
_DUMMY_PASSWORD_HASH = bcrypt.hashpw(b"dummy-password-nao-e-credencial-real", bcrypt.gensalt()).decode("utf-8")


async def register_failed_attempt(email: str) -> None:
    """Soma 1 tentativa falha e tranca a conta se bater o limite.

    UPDATE atômico com CASE no próprio SQL — evita race condition de duas
    requisições concorrentes lendo o mesmo contador antes de qualquer uma
    escrever (senão dava pra passar de 5 tentativas sem travar em ataques
    com requisições paralelas).
    """
    async with acquire_connection() as conn:
        await conn.execute(
            """
            UPDATE users
            SET failed_login_attempts = failed_login_attempts + 1,
                locked_until = CASE
                    WHEN failed_login_attempts + 1 >= $2 THEN now() + $3
                    ELSE locked_until
                END
            WHERE email = $1
            """,
            email,
            settings.max_login_attempts,
            timedelta(minutes=settings.lockout_minutes),
        )


async def reset_failed_attempts(email: str) -> None:
    """Zera o contador no login bem-sucedido."""
    async with acquire_connection() as conn:
        await conn.execute(
            """
            UPDATE users
            SET failed_login_attempts = 0,
                locked_until = NULL
            WHERE email = $1
            """,
            email,
        )


async def is_account_locked(email: str) -> bool:
    """True se a conta ainda está dentro do período de bloqueio.

    Checar isso ANTES de validar a senha poupa o custo de CPU do bcrypt e
    não dá munição extra pra quem estiver forçando a conta trancada.
    """
    async with acquire_connection() as conn:
        locked_until = await conn.fetchval(
            "SELECT locked_until FROM users WHERE email = $1",
            email,
        )
    return locked_until is not None and locked_until > datetime.now(timezone.utc)


async def hash_password(password: str) -> str:
    """Hash de senha rodando bcrypt fora da event loop.

    bcrypt é deliberadamente lento (isso que dificulta brute-force), mas
    ~100-300ms bloqueando a thread principal do asyncio travaria TODA
    requisição concorrente no servidor. to_thread joga pra uma threadpool
    e mantém o loop livre enquanto isso.
    """

    def _hash() -> str:
        return bcrypt.hashpw(password.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

    return await asyncio.to_thread(_hash)


async def verify_password(password: str, password_hash: str) -> bool:
    def _verify() -> bool:
        return bcrypt.checkpw(password.encode("utf-8"), password_hash.encode("utf-8"))

    return await asyncio.to_thread(_verify)


class InvalidCredentialsError(Exception):
    """Email ou senha errados — mensagem genérica de propósito."""


class AccountLockedError(Exception):
    """Conta travada por excesso de tentativas falhas."""


async def authenticate(email: str, password: str) -> str:
    """Orquestra o login inteiro: lock check -> busca usuário -> valida senha.

    Nunca revela se foi o email que não existe ou a senha que está errada
    — as duas situações levantam o mesmo InvalidCredentialsError. Isso evita
    dar munição pra quem estiver testando quais emails têm conta (user
    enumeration).

    Retorna o id do usuário autenticado, pra quem chamou poder emitir o
    token de acesso.
    """
    if await is_account_locked(email):
        raise AccountLockedError("Conta temporariamente bloqueada")

    async with acquire_connection() as conn:
        row = await conn.fetchrow(
            "SELECT id, password_hash FROM users WHERE email = $1", email
        )

    if row is None:
        # Roda o bcrypt mesmo sem usuario pra gastar o mesmo tempo do
        # caminho onde o usuario existe -- ver _DUMMY_PASSWORD_HASH.
        await verify_password(password, _DUMMY_PASSWORD_HASH)
        raise InvalidCredentialsError("Email ou senha inválidos")

    if not await verify_password(password, row["password_hash"]):
        await register_failed_attempt(email)
        raise InvalidCredentialsError("Email ou senha inválidos")

    await reset_failed_attempts(email)
    return str(row["id"])


class InvalidTokenError(Exception):
    """Token ausente, expirado ou com assinatura inválida."""


def create_access_token(user_id: str) -> str:
    """Emite um JWT assinado com o user_id como subject.

    Stateless de propósito: nada fica salvo no servidor, só validamos
    assinatura e expiração a cada requisição. Em troca de simplicidade,
    perdemos a capacidade de revogar um token antes dele expirar — aceitável
    pro escopo atual, sem blacklist de tokens por enquanto.
    """
    expire = datetime.now(timezone.utc) + timedelta(minutes=settings.jwt_expire_minutes)
    payload = {"sub": user_id, "exp": expire}
    return jwt.encode(payload, settings.jwt_secret_key, algorithm=settings.jwt_algorithm)


def decode_access_token(token: str) -> str:
    """Valida o JWT e devolve o user_id (subject).

    Levanta InvalidTokenError se a assinatura não bater ou o token tiver
    expirado — quem chamar decide o que fazer (normalmente devolver 401).
    """
    try:
        payload = jwt.decode(token, settings.jwt_secret_key, algorithms=[settings.jwt_algorithm])
    except jwt.PyJWTError:
        raise InvalidTokenError("Token inválido ou expirado") from None
    return payload["sub"]

security = HTTPBearer()


async def get_current_user(credentials: HTTPAuthorizationCredentials = Depends(security)) -> str:
    """Dependency pra proteger rota: `Depends(get_current_user)` no parametro da rota.

    Le o header "Authorization: Bearer <token>", valida e devolve o user_id.
    Se faltar o header ou o token for invalido/expirado, corta com 401 antes
    de qualquer linha de codigo da rota rodar.
    """
    try:
        return decode_access_token(credentials.credentials)
    except InvalidTokenError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Token invalido ou expirado",
            headers={"WWW-Authenticate": "Bearer"},
        )


# --- Rate limit por IP no /login -----------------------------------------
# O lockout por conta (register_failed_attempt) protege UMA conta especifica,
# mas nao impede um atacante de tentar milhares de emails diferentes sem
# limite. Isso complementa com um teto por IP, independente de qual conta
# esta sendo tentada. Em memoria mesmo (janela fixa) -- app roda num
# processo uvicorn so, nao precisa de Redis pra esse volume.
_login_attempts_by_ip: dict[str, list[float]] = {}
LOGIN_RATE_LIMIT_MAX = 20
LOGIN_RATE_LIMIT_WINDOW_SECONDS = 300.0


def check_ip_rate_limit(ip: str) -> bool:
    """True se o IP ainda esta dentro do limite (e ja registra essa
    tentativa). False se estourou -- quem chamar deve cortar com 429."""
    now = time.monotonic()
    window_start = now - LOGIN_RATE_LIMIT_WINDOW_SECONDS
    attempts = [t for t in _login_attempts_by_ip.get(ip, []) if t > window_start]
    attempts.append(now)
    _login_attempts_by_ip[ip] = attempts
    return len(attempts) <= LOGIN_RATE_LIMIT_MAX


# --- Tickets de uso unico pro WebSocket -----------------------------------
# WebSocket nativo do navegador nao manda header Authorization, entao o
# jeito padrao e mandar credencial na query string -- mas isso fica gravado
# em texto puro no log de acesso do Nginx. Em vez de mandar o JWT de sessao
# (que vive 60min) na URL, o cliente pede um ticket aleatorio e descartavel
# (30s, uso unico) por uma chamada HTTP normal com o header Authorization de
# verdade, e usa esse ticket na URL do WebSocket. Mesmo vazando no log, o
# ticket expira rapido e ja foi consumido na primeira conexao.
_ws_tickets: dict[str, tuple[str, float]] = {}
WS_TICKET_TTL_SECONDS = 30.0


def _prune_expired_tickets() -> None:
    now = time.monotonic()
    expired = [t for t, (_, exp) in _ws_tickets.items() if exp < now]
    for t in expired:
        del _ws_tickets[t]


def create_ws_ticket(user_id: str) -> str:
    _prune_expired_tickets()
    ticket = secrets.token_urlsafe(32)
    _ws_tickets[ticket] = (user_id, time.monotonic() + WS_TICKET_TTL_SECONDS)
    return ticket


def consume_ws_ticket(ticket: str) -> str | None:
    """Valida e ja consome o ticket (remove da memoria na primeira leitura,
    valido ou nao -- uso unico de verdade). None se invalido/expirado."""
    _prune_expired_tickets()
    entry = _ws_tickets.pop(ticket, None)
    if entry is None:
        return None
    user_id, expires_at = entry
    if expires_at < time.monotonic():
        return None
    return user_id