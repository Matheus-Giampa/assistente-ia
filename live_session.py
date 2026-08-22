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


RESUME_PROMPT_WITH_CONTEXT = (
    "A conexao caiu por um problema tecnico e acabou de ser restabelecida -- voce "
    "ja tem o contexto de toda a conversa ate agora (session resumption do Gemini "
    "Live). Avise brevemente que a conexao voltou e continue de onde parou, sem "
    "recomecar do zero nem repetir o que ja foi dito."
)

# So usado quando o handle de resumption ainda nao existia (caiu logo no
# comeco, antes do primeiro session_resumption_update chegar) -- nesse caso
# a sessao nova E realmente sem contexto nenhum, entao nao da pra fingir que
# lembra de algo.
RESUME_PROMPT_NO_CONTEXT = (
    "A conversa caiu por um problema tecnico logo no inicio, antes de conseguir "
    "guardar o contexto -- essa sessao nao tem memoria da conversa anterior. "
    "Cumprimente o usuario avisando que a conexao caiu e comece de novo."
)


async def run_audio_bridge(
    websocket: WebSocket,
    system_prompt: str,
    resume: bool = False,
    resumption_handle: str | None = None,
) -> None:
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

    resume=True quando o frontend reconectou sozinho apos detectar que a
    sessao anterior travou (Gemini parou de responder, mas a conexao TCP
    nao caiu). resumption_handle e o token de "session resumption" nativo
    do Gemini Live (ver session_resumption_update abaixo) -- com ele a
    sessao nova recebe o HISTORICO REAL da conversa (nao um resumo/prompt
    fingindo lembrar), entao a IA de fato continua de onde parou em vez de
    comecar do zero.
    """
    config = {
        "response_modalities": ["AUDIO"],
        "system_instruction": system_prompt,
        # Sempre habilita o tracking de resumption, mesmo em sessao nova
        # (handle=None) -- assim ja tem um handle pronto pra usar caso o
        # watchdog do frontend precise reconectar mais tarde nessa mesma
        # conversa.
        "session_resumption": {"handle": resumption_handle},
    }

    async with _client.aio.live.connect(model=MODEL, config=config) as session:
        if resume:
            prompt = RESUME_PROMPT_WITH_CONTEXT if resumption_handle else RESUME_PROMPT_NO_CONTEXT
            await session.send_client_content(
                turns={"role": "user", "parts": [{"text": prompt}]},
                turn_complete=True,
            )

        async def client_to_gemini() -> None:
            while True:
                chunk = await websocket.receive_bytes()
                await session.send_realtime_input(
                    audio=types.Blob(data=chunk, mime_type="audio/pcm;rate=16000")
                )

        async def gemini_to_client() -> None:
            # session.receive() e um generator POR TURNO -- ele termina
            # sozinho (sem exception) quando aquele turno acaba
            # (turnComplete=True), nao quando a sessao inteira acaba.
            # Por isso o loop externo: cada vez que um turno termina,
            # chama session.receive() de novo pra continuar ouvindo o
            # proximo turno da conversa.
            while True:
                async for response in session.receive():
                    if response.go_away:
                        logger.info("Gemini avisou go_away: time_left=%s", response.go_away.time_left)
                        await websocket.send_text(json.dumps({
                            "type": "go_away",
                            "time_left": response.go_away.time_left,
                        }))

                    if response.session_resumption_update:
                        update = response.session_resumption_update
                        # So repassa handle resumable -- um handle nao-resumable
                        # (ex.: sessao ja invalidada) nao serve pra nada num
                        # reconnect futuro.
                        if update.resumable and update.new_handle:
                            await websocket.send_text(json.dumps({
                                "type": "session_handle",
                                "handle": update.new_handle,
                            }))

                    if not response.server_content:
                        continue

                    if response.server_content.interrupted:
                        await websocket.send_text(json.dumps({"type": "interrupted"}))

                    if response.server_content.model_turn:
                        for part in response.server_content.model_turn.parts:
                            if part.inline_data:
                                await websocket.send_bytes(part.inline_data.data)

                    if response.server_content.turn_complete:
                        # Manda por ultimo, sempre depois do audio -- se
                        # audio e turn_complete vierem juntos na mesma
                        # resposta, o cliente precisa ver o audio primeiro
                        # e "turn_complete" como a palavra final, senao a
                        # flag de "IA falando" do frontend fica travada em
                        # true pra sempre (audio chegando depois do aviso
                        # reativa ela sem ter mais nenhum turn_complete
                        # posterior pra desligar de novo).
                        await websocket.send_text(json.dumps({"type": "turn_complete"}))

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
                if exc:
                    logger.info("Task %s terminou com exception: %r", task.get_coro(), exc)
                if exc and not isinstance(exc, WebSocketDisconnect):
                    raise exc
        finally:
            for task in tasks:
                task.cancel()
