from contextlib import asynccontextmanager

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, RedirectResponse
from pydantic import BaseModel, EmailStr

from auth import (
    AccountLockedError,
    InvalidCredentialsError,
    authenticate,
    check_ip_rate_limit,
    consume_ws_ticket,
    create_access_token,
    create_ws_ticket,
    get_current_user,
    list_login_events,
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


@app.get("/", include_in_schema=False)
async def root() -> RedirectResponse:
    # So pra evitar 404 confuso -- API nao tem front proprio, manda quem
    # visitar a raiz direto pra documentacao interativa.
    return RedirectResponse(url="/docs")


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
async def login(payload: LoginRequest, request: Request):
    client_ip = request.client.host if request.client else "unknown"
    if not check_ip_rate_limit(client_ip):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Muitas tentativas, tente novamente mais tarde",
        )

    try:
        user_id = await authenticate(payload.email, payload.password, ip_address=client_ip)
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


class LoginEventOut(BaseModel):
    email: str
    success: bool
    ip_address: str | None
    created_at: str


@app.get("/login-events", response_model=list[LoginEventOut])
async def get_login_events(user_id: str = Depends(get_current_user)):
    # Painel de auditoria -- qualquer usuario logado ve o historico global
    # de tentativas de login (app pequeno, sem conceito de admin ainda).
    events = await list_login_events()
    return [
        {**e, "created_at": e["created_at"].isoformat()}
        for e in events
    ]


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


@app.post("/ws-ticket")
async def get_ws_ticket(user_id: str = Depends(get_current_user)):
    # Ticket de uso unico e vida curta (30s) pra autenticar o WebSocket de
    # audio sem mandar o JWT de sessao na URL -- ver auth.py, create_ws_ticket.
    return {"ticket": create_ws_ticket(user_id)}


@app.websocket("/ws/session/{mission_id}")
async def audio_session(websocket: WebSocket, mission_id: str) -> None:
    # WebSocket nativo do navegador nao manda header Authorization -- por
    # isso o ticket descartavel (nao o JWT de sessao) vem via query string
    # (ws://.../ws/session/x?ticket=...).
    ticket = websocket.query_params.get("ticket")
    if not ticket or consume_ws_ticket(ticket) is None:
        await websocket.close(code=4401)
        return

    system_prompt = await get_mission_system_prompt(mission_id)
    if system_prompt is None:
        await websocket.close(code=4404)
        return

    resume = websocket.query_params.get("resume") == "true"

    await websocket.accept()

    try:
        await run_audio_bridge(websocket, system_prompt, resume=resume)
    except WebSocketDisconnect:
        pass
    finally:
        try:
            await websocket.close()
        except (RuntimeError, WebSocketDisconnect):
            # ja fechado por um dos dois lados (cliente caiu, rede, etc) --
            # tentar fechar de novo so pra confirmar nao eh erro de verdade.
            pass