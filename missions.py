from database import acquire_connection


async def list_missions() -> list[dict]:
    """Lista as missoes disponiveis pro frontend.

    Nao seleciona system_prompt de proposito -- esse campo fica reservado
    pra quando abrirmos a sessao de audio com o Gemini, nunca sai daqui
    pro cliente.
    """
    async with acquire_connection() as conn:
        rows = await conn.fetch(
            "SELECT id, mode, title, description, emoji, accent_color FROM missions ORDER BY title"
        )
    return [dict(row) for row in rows]


async def get_mission_system_prompt(mission_id: str) -> str | None:
    """Busca o system_prompt de uma missao especifica pelo id.

    Uso interno do backend (ex: ao abrir a sessao com o Gemini Live) --
    nao existe rota que devolva isso pro cliente.
    """
    async with acquire_connection() as conn:
        return await conn.fetchval(
            "SELECT system_prompt FROM missions WHERE id = $1", mission_id
        )
