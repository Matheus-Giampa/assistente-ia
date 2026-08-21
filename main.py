from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from database import DatabaseUnavailableError, close_db_connection, connect_to_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Pool sobe junto com o processo e morre junto com ele — ver database.py
    # para o porque do fail-fast aqui (sem banco, sem servidor de pé).
    await connect_to_db()
    yield
    await close_db_connection()


app = FastAPI(title="API Vozes", version="0.1.0", lifespan=lifespan)


@app.exception_handler(DatabaseUnavailableError)
async def database_unavailable_handler(request: Request, exc: DatabaseUnavailableError) -> JSONResponse:
    # Anti-leak: o cliente nunca vê detalhe de Postgres/asyncpg aqui — só um
    # 500 genérico. O log completo (stacktrace, query, etc) já rolou lá no
    # acquire_connection() do database.py via logger.exception.
    return JSONResponse(status_code=500, content={"detail": "Erro interno no servidor"})


@app.get("/health")
async def health_check():
    return {"status": "ok", "message": "Servidor rodando liso"}