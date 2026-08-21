from contextlib import asynccontextmanager

from fastapi import FastAPI

from database import close_db_connection, connect_to_db


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Pool sobe junto com o processo e morre junto com ele — ver database.py
    # para o porque do fail-fast aqui (sem banco, sem servidor de pé).
    await connect_to_db()
    yield
    await close_db_connection()


app = FastAPI(title="API Vozes", version="0.1.0", lifespan=lifespan)

@app.get("/health")
async def health_check():
    return {"status": "ok", "message": "Servidor rodando liso"}