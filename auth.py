import asyncio
import logging
from datetime import datetime, timedelta, timezone
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
import bcrypt
import jwt

from config import get_settings
from database import acquire_connection

logger = logging.getLogger(__name__)

settings = get_settings()


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
        # TODO: considerar comparar contra um hash fixo/dummy aqui pra igualar
        # o tempo de resposta entre "email não existe" e "senha errada" —
        # hoje esse caminho é mais rápido por pular o bcrypt, o que em teoria
        # dá pra medir por timing attack. Baixa prioridade pro estágio atual.
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