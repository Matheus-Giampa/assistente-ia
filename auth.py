import logging
from datetime import datetime, timedelta, timezone

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