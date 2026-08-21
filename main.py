from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from pydantic import BaseModel, EmailStr

from auth import (
    AccountLockedError,
    InvalidCredentialsError,
    InvalidTokenError,
    authenticate,
    create_access_token,
    decode_access_token,
    get_current_user,
)

from database import DatabaseUnavailableError, close_db_connection, connect_to_db
from live_session import run_audio_bridge
from missions import get_mission_system_prompt, list_missions


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Pool sobe junto com o processo e morre junto com ele — ver database.py
    # para o porque do fail-fast aqui (sem banco, sem servidor de pé).
    await connect_to_db()
    yield
    await close_db_connection()


app = FastAPI(title="API Vozes", version="0.1.0", lifespan=lifespan)

# TODO: acrescentar aqui o dominio do frontend em producao quando ele for
# publicado (ex: https://app.assistente-ia.duckdns.org). Por enquanto so
# libera o dev server local do Vite.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:5173"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.exception_handler(DatabaseUnavailableError)
async def database_unavailable_handler(request: Request, exc: DatabaseUnavailableError) -> JSONResponse:
    # Anti-leak: o cliente nunca vê detalhe de Postgres/asyncpg aqui — só um
    # 500 genérico. O log completo (stacktrace, query, etc) já rolou lá no
    # acquire_connection() do database.py via logger.exception.
    return JSONResponse(status_code=500, content={"detail": "Erro interno no servidor"})


@app.get("/health")
async def health_check():
    return {"status": "ok", "message": "Servidor rodando liso"}


class LoginRequest(BaseModel):
    email: EmailStr
    password: str


@app.post("/login")
async def login(payload: LoginRequest):
    try:
        user_id = await authenticate(payload.email, payload.password)
    except AccountLockedError:
        raise HTTPException(
            status_code=status.HTTP_423_LOCKED,
            detail="Conta temporariamente bloqueada, tente novamente mais tarde",
        )
    except InvalidCredentialsError:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Email ou senha inválidos",
        )

    access_token = create_access_token(user_id)
    return {"access_token": access_token, "token_type": "bearer"}


@app.get("/me")
async def me(user_id: str = Depends(get_current_user)):
    return {"user_id": user_id}


class MissionOut(BaseModel):
    id: str
    mode: str
    title: str
    description: str
    emoji: str
    accent_color: str


@app.get("/missions", response_model=list[MissionOut])
async def get_missions(user_id: str = Depends(get_current_user)):
    # "Zero ping anonimo" -- ate a lista de missoes exige token valido,
    # nao tem endpoint publico nessa API.
    return await list_missions()


@app.websocket("/ws/session/{mission_id}")
async def audio_session(websocket: WebSocket, mission_id: str) -> None:
    # WebSocket nativo do navegador nao manda header Authorization -- o
    # token vem via query string mesmo (ws://.../ws/session/x?token=...).
    token = websocket.query_params.get("token")
    if not token:
        await websocket.close(code=4401)
        return

    try:
        decode_access_token(token)
    except InvalidTokenError:
        await websocket.close(code=4401)
        return

    system_prompt = await get_mission_system_prompt(mission_id)
    if system_prompt is None:
        await websocket.close(code=4404)
        return

    await websocket.accept()

    try:
        await run_audio_bridge(websocket, system_prompt)
    except WebSocketDisconnect:
        pass
    finally:
        try:
            await websocket.close()
        except RuntimeError:
            # ja fechado por um dos dois lados, tudo bem
            pass