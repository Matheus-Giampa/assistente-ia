import asyncio
import logging
from contextlib import asynccontextmanager

import asyncpg

from config import get_settings

logger = logging.getLogger(__name__)

settings = get_settings()

_pool: asyncpg.Pool | None = None


class DatabaseUnavailableError(Exception):
    """Erro genérico que sai da camada de dados pra cima.

    De propósito sem detalhe de asyncpg/Postgres na mensagem — quem pegar
    essa exception (exception handler do FastAPI) devolve um 500 genérico
    pro cliente. O detalhe de verdade fica só no log interno.
    """


async def connect_to_db() -> None:
    """Sobe o pool de conexões. Chamado no startup do FastAPI (lifespan).

    Fail-fast de propósito: se o Postgres estiver fora do ar quando o
    processo sobe, deixamos a exception estourar e o Uvicorn nem termina
    de subir. Preferível um deploy que falha alto a um servidor de pé
    devolvendo 500 pra tudo porque não tem banco.
    """
    global _pool

    try:
        _pool = await asyncpg.create_pool(
            dsn=str(settings.database_url),
            min_size=settings.db_pool_min_size,
            max_size=settings.db_pool_max_size,
            command_timeout=settings.db_command_timeout,
            timeout=settings.db_connect_timeout,
            # TODO: setar ssl="require" quando migrarmos pra produção
            # (RDS/Supabase/Neon geralmente exigem TLS na conexão)
        )
    except (asyncpg.PostgresError, OSError):
        logger.exception("Falha ao subir o pool de conexões com o Postgres")
        raise

    logger.info(
        "Pool de conexões no ar (min=%s, max=%s)",
        settings.db_pool_min_size,
        settings.db_pool_max_size,
    )


async def close_db_connection() -> None:
    """Fecha o pool no shutdown do FastAPI.

    Espera as conexões em uso devolverem ao pool, mas com um teto — não
    queremos o processo travado no shutdown por causa de uma query
    pendurada em algum WebSocket de áudio que não finalizou direito.
    """
    global _pool

    if _pool is None:
        return

    try:
        await asyncio.wait_for(_pool.close(), timeout=settings.db_connect_timeout)
    except asyncio.TimeoutError:
        # FIXME: avaliar _pool.terminate() aqui em vez de só logar — por ora
        # preferimos não matar conexão à força e seguir o shutdown mesmo assim.
        logger.warning("Timeout fechando o pool, seguindo com o shutdown mesmo assim")
    finally:
        _pool = None
        logger.info("Pool de conexões encerrado")


def get_pool() -> asyncpg.Pool:
    """Dependency pra usar nos routers via Depends(get_pool).

    Não é "pegar uma conexão" — é só entregar o pool. Quem consumir decide
    se usa acquire_connection() abaixo ou faz o próprio `async with
    pool.acquire()`.
    """
    if _pool is None:
        # Não deveria acontecer em produção (lifespan garante o startup),
        # mas protege scripts/testes que pularam a inicialização.
        raise DatabaseUnavailableError("Pool de conexões não inicializado")
    return _pool


@asynccontextmanager
async def acquire_connection():
    """Empréstimo de conexão com rede de segurança anti-leak.

    Qualquer PostgresError (timeout, deadlock, constraint violation, banco
    caiu, sei lá) vira DatabaseUnavailableError pra cima. O caller não deve
    saber qual foi o erro específico — isso já foi logado com stacktrace
    completo aqui embaixo.
    """
    pool = get_pool()
    try:
        async with pool.acquire() as conn:
            yield conn
    except asyncpg.PostgresError:
        logger.exception("Erro ao executar operação no Postgres")
        raise DatabaseUnavailableError("Falha ao acessar o banco de dados") from None