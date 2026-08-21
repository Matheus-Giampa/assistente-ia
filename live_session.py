import asyncio
import json
import logging

from fastapi import WebSocket, WebSocketDisconnect
from google import genai
from google.genai import types

from config import get_settings

logger = logging.getLogger(__name__)

settings = get_settings()

# Gemini 2.5 Flash com audio nativo (nao half-cascade) -- trocado de
# proposito pra usar a chave com cota maior.
# TODO: revisitar esse nome quando o Gemini Live sair de preview -- modelos
# preview mudam de nome/fica deprecado sem muito aviso previo.
MODEL = "gemini-2.5-flash-native-audio-preview-12-2025"

_client = genai.Client(api_key=settings.gemini_api_key)


async def run_audio_bridge(websocket: WebSocket, system_prompt: str) -> None:
    """Abre a sessao com o Gemini Live e faz a ponte de audio nos dois
    sentidos ate qualquer um dos lados (cliente ou Gemini) encerrar.

    Duas tasks concorrentes: uma le bytes do WebSocket do cliente e manda
    pro Gemini, outra le a resposta do Gemini e manda de volta pro cliente.
    Quando uma termina (por desconexao, por exemplo), cancela a outra --
    nao faz sentido continuar bombeando audio pra um lado morto.

    Alem do audio bruto (mensagens binarias), manda mensagens de texto JSON
    como sinal de controle pro cliente -- "interrupted" quando o usuario
    fala por cima do Gemini (precisa parar e limpar o que ja tava tocando,
    senao vira audio picado de turnos sobrepostos) e "go_away" quando o
    Gemini avisa que vai derrubar a conexao em breve.
    """
    config = {
        "response_modalities": ["AUDIO"],
        "system_instruction": system_prompt,
    }

    async with _client.aio.live.connect(model=MODEL, config=config) as session:

        async def client_to_gemini() -> None:
            while True:
                chunk = await websocket.receive_bytes()
                await session.send_realtime_input(
                    audio=types.Blob(data=chunk, mime_type="audio/pcm;rate=16000")
                )

        async def gemini_to_client() -> None:
            async for response in session.receive():
                if response.go_away:
                    logger.info("Gemini avisou go_away: time_left=%s", response.go_away.time_left)
                    await websocket.send_text(json.dumps({
                        "type": "go_away",
                        "time_left": response.go_away.time_left,
                    }))

                if not response.server_content:
                    continue

                if response.server_content.interrupted:
                    await websocket.send_text(json.dumps({"type": "interrupted"}))

                if not response.server_content.model_turn:
                    continue

                for part in response.server_content.model_turn.parts:
                    if part.inline_data:
                        await websocket.send_bytes(part.inline_data.data)

        tasks = [
            asyncio.create_task(client_to_gemini()),
            asyncio.create_task(gemini_to_client()),
        ]
        try:
            done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
            for task in pending:
                task.cancel()
            for task in done:
                exc = task.exception()
                if exc and not isinstance(exc, WebSocketDisconnect):
                    raise exc
        finally:
            for task in tasks:
                task.cancel()
