import { useCallback, useEffect, useRef, useState } from "react";
import { createWsTicket } from "../api/client";

type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

// Formatos exigidos pelo Gemini Live -- ver live_session.py no backend.
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

// Em dev, VITE_API_URL e absoluta (http://localhost:8000). Em producao e
// relativa (/api), porque frontend e backend ficam no mesmo dominio atras
// do Nginx -- nesse caso monta o ws:// a partir da origem atual da pagina.
function resolveWsUrl(apiUrl: string): string {
  if (/^https?:\/\//.test(apiUrl)) {
    return apiUrl.replace(/^http/, "ws");
  }
  const scheme = window.location.protocol === "https:" ? "wss" : "ws";
  return `${scheme}://${window.location.host}${apiUrl}`;
}

function floatToInt16(input: Float32Array): Int16Array {
  const output = new Int16Array(input.length);
  for (let i = 0; i < input.length; i++) {
    const s = Math.max(-1, Math.min(1, input[i]));
    output[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
  }
  return output;
}

function int16ToFloat(input: Int16Array): Float32Array {
  const output = new Float32Array(input.length);
  for (let i = 0; i < input.length; i++) {
    output[i] = input[i] / 0x8000;
  }
  return output;
}

interface ControlMessage {
  type: "interrupted" | "go_away" | "turn_complete" | "session_handle";
  time_left?: string;
  handle?: string;
}

// Quanto tempo sem NENHUMA resposta do Gemini (audio ou sinal de controle)
// depois do usuario falar pra considerar que ele travou/parou de responder.
const NO_RESPONSE_TIMEOUT_MS = 20000;

// Defesa Nivel 2: quanto tempo sem VOZ DETECTADA no microfone (usuario
// sumiu/deixou a aba aberta) antes de derrubar a sessao Gemini Live sozinha
// -- ela fica com o "medidor" ligado (e sendo cobrada) enquanto o WebSocket
// existir, mesmo que ninguem fale.
const USER_SILENCE_TIMEOUT_MS = 5 * 60 * 1000;

// RMS acima disso conta como "tem alguem falando" no chunk de ~256ms. Abaixo
// disso e ruido de fundo (o getUserMedia ja pede noiseSuppression). Nao e
// deteccao de fala robusta, so o suficiente pra distinguir sala em silencio
// de alguem falando.
const VOICE_ACTIVITY_RMS_THRESHOLD = 0.02;

function hasVoiceActivity(samples: Float32Array): boolean {
  let sumSquares = 0;
  for (let i = 0; i < samples.length; i++) {
    sumSquares += samples[i] * samples[i];
  }
  const rms = Math.sqrt(sumSquares / samples.length);
  return rms > VOICE_ACTIVITY_RMS_THRESHOLD;
}

export function useAudioSession(missionId: string, token: string) {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [muted, setMuted] = useState(false);
  const [noResponse, setNoResponse] = useState(false);
  const [endedBySilence, setEndedBySilence] = useState(false);
  // Espelha isAiSpeakingRef pra UI poder mostrar "IA falando..." -- o envio
  // do mic ja fica pausado nesse intervalo (ver isAiSpeakingRef mais abaixo),
  // isso e so o reflexo visual do que ja acontece de verdade.
  const [aiSpeaking, setAiSpeaking] = useState(false);

  // Cada start() incrementa e captura seu proprio numero. Se, quando o
  // codigo assincrono (ticket, getUserMedia, WebSocket abrindo) finalmente
  // resolver, o numero atual nao bater mais com o capturado, essa chamada
  // foi substituida por outra (StrictMode do React monta o componente 2x em
  // dev, ou um clique duplo em "Comecar") -- aborta em vez de deixar DUAS
  // sessoes Gemini Live abertas ao mesmo tempo ouvindo o mesmo microfone e
  // respondendo em paralelo (bug real: parecia a IA repetindo a fala).
  const sessionEpochRef = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
  const workletNodeRef = useRef<AudioWorkletNode | null>(null);
  // Handle de "session resumption" nativo do Gemini Live -- atualizado a
  // cada "session_handle" que chega do backend. Preservado entre um stop()
  // e o start(true) seguinte (reconnect do watchdog), pra sessao nova pedir
  // pro Gemini restaurar o HISTORICO REAL da conversa em vez de comecar do
  // zero. So zera num start(false) de verdade (conversa nova).
  const sessionHandleRef = useRef<string | null>(null);
  const mutedRef = useRef(false);
  const playbackTimeRef = useRef(0);
  const activeSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  // True enquanto o Gemini esta com a vez de falar -- pausa o envio do
  // microfone nesse intervalo pra evitar auto-interrupcao por eco/ruido
  // (era a causa do audio picotado). Vira false de novo no "turn_complete".
  const isAiSpeakingRef = useRef(false);
  // Watchdog: se nao chegar audio novo nem turn_complete por um tempo,
  // destrava o microfone sozinho. Rede de seguranca contra qualquer bug
  // futuro que deixe isAiSpeakingRef preso em true pra sempre (ja aconteceu
  // uma vez por causa de mensagem com audio + turn_complete juntos).
  const speakingWatchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function armSpeakingWatchdog() {
    if (speakingWatchdogRef.current) clearTimeout(speakingWatchdogRef.current);
    speakingWatchdogRef.current = setTimeout(() => {
      isAiSpeakingRef.current = false;
      setAiSpeaking(false);
    }, 3000);
  }

  // Detecta o Gemini "travando" (conexao continua aberta, mas ele para de
  // responder de vez) -- visto acontecer de verdade em sessao longa com
  // modelo preview. Rearmado a cada chunk de audio que o usuario manda;
  // se estourar sem nenhuma resposta chegar antes, avisa na tela em vez
  // de deixar o usuario falando sem retorno nenhum.
  const noResponseTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Indirecao pra chamar o reconnect() de dentro do watchdog sem depender
  // de ordem de declaracao (reconnect() usa start/stop, definidos abaixo).
  // silent=true quando a troca e proativa (go_away, antes do Gemini derrubar
  // de vez) -- nesse caso nao anuncia nada pro usuario nem pra IA, porque da
  // perspectiva de quem esta conversando nada quebrou.
  const reconnectRef = useRef<(silent?: boolean) => void>(() => {});
  // Se o go_away chegar enquanto a IA esta no meio de uma fala, guarda a
  // troca pendente e so executa no proximo turn_complete/interrupted --
  // trocar no meio do audio cortaria a fala dela pela metade.
  const pendingGoAwayRef = useRef(false);

  function armNoResponseWatchdog() {
    if (noResponseTimeoutRef.current) clearTimeout(noResponseTimeoutRef.current);
    noResponseTimeoutRef.current = setTimeout(() => {
      setNoResponse(true);
      reconnectRef.current();
    }, NO_RESPONSE_TIMEOUT_MS);
  }

  function clearNoResponseWatchdog() {
    if (noResponseTimeoutRef.current) clearTimeout(noResponseTimeoutRef.current);
    setNoResponse(false);
  }

  const userSilenceTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  function armUserSilenceWatchdog() {
    if (userSilenceTimeoutRef.current) clearTimeout(userSilenceTimeoutRef.current);
    userSilenceTimeoutRef.current = setTimeout(() => {
      stop();
      setEndedBySilence(true);
    }, USER_SILENCE_TIMEOUT_MS);
  }

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const toggleMute = useCallback(() => {
    setMuted((current) => {
      const next = !current;
      if (next && wsRef.current?.readyState === WebSocket.OPEN) {
        // Usuario mutou de proposito -- trata como "terminei de falar" e
        // avisa o backend, que manda audio_stream_end pro Gemini processar
        // o turno agora em vez de esperar o VAD dele perceber sozinho (as
        // vezes demora e da a impressao de que a IA nao respondeu).
        wsRef.current.send(JSON.stringify({ type: "mute" }));
      }
      return next;
    });
  }, []);

  const stop = useCallback(() => {
    // Invalida qualquer start() ainda em andamento (esperando ticket,
    // permissao de mic, etc.) -- sem isso, um stop() no meio de um start()
    // lento nao impede a sessao de "ressuscitar" quando o await resolver.
    sessionEpochRef.current += 1;

    wsRef.current?.close();
    wsRef.current = null;

    processorRef.current?.disconnect();
    processorRef.current = null;

    if (workletNodeRef.current) {
      workletNodeRef.current.port.onmessage = null;
      workletNodeRef.current.disconnect();
      workletNodeRef.current = null;
    }

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    void inputContextRef.current?.close();
    inputContextRef.current = null;

    void outputContextRef.current?.close();
    outputContextRef.current = null;

    activeSourcesRef.current = [];
    isAiSpeakingRef.current = false;
    setAiSpeaking(false);
    if (speakingWatchdogRef.current) clearTimeout(speakingWatchdogRef.current);
    if (noResponseTimeoutRef.current) clearTimeout(noResponseTimeoutRef.current);
    if (userSilenceTimeoutRef.current) clearTimeout(userSilenceTimeoutRef.current);
    setNoResponse(false);
    setStatus("closed");
  }, []);

  const start = useCallback(async (resume = false, silent = false) => {
    // Marca essa chamada como a "atual" -- qualquer start() ou stop()
    // seguinte muda sessionEpochRef.current e faz essa chamada se
    // reconhecer como obsoleta nos pontos de checagem abaixo.
    const myEpoch = ++sessionEpochRef.current;
    const isStale = () => sessionEpochRef.current !== myEpoch;

    setStatus("connecting");
    setEndedBySilence(false);
    if (!resume) sessionHandleRef.current = null;

    // Ticket descartavel (30s, uso unico) em vez do JWT de sessao direto na
    // URL do WebSocket -- token de sessao nunca aparece em log de acesso.
    let ticket: string;
    try {
      ticket = await createWsTicket(token);
    } catch {
      setStatus("error");
      return;
    }

    if (isStale()) return;

    const apiUrl = import.meta.env.VITE_API_URL as string;
    const wsUrl = resolveWsUrl(apiUrl);
    const resumeParam = resume ? "&resume=true" : "";
    const silentParam = silent ? "&silent=true" : "";
    const handleParam = sessionHandleRef.current
      ? `&session_handle=${encodeURIComponent(sessionHandleRef.current)}`
      : "";
    const ws = new WebSocket(
      `${wsUrl}/ws/session/${missionId}?ticket=${ticket}${resumeParam}${silentParam}${handleParam}`,
    );
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const outputContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    outputContextRef.current = outputContext;
    playbackTimeRef.current = outputContext.currentTime;

    ws.onopen = async () => {
      if (isStale()) {
        // Essa chamada de start() ja foi substituida por outra (StrictMode
        // do React remontando em dev, ou um segundo start() disparado antes
        // desse abrir) -- fecha essa conexao orfa em vez de deixar 2
        // sessoes Gemini Live ativas ao mesmo tempo ouvindo o mesmo mic.
        ws.close();
        return;
      }

      setStatus("open");
      armNoResponseWatchdog();
      armUserSilenceWatchdog();

      // TODO: Defesa Nivel 1 (Mute Inteligente) ja fica pronta aqui de graca
      // -- o mutedRef.current dentro do onaudioprocess corta o envio de
      // chunk sem fechar o WebSocket, exatamente como o briefing pede.
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            noiseSuppression: true,
            echoCancellation: true,
            autoGainControl: true,
          },
        });

        if (isStale()) {
          // Idem, mas depois de ja ter pego o microfone -- solta os tracks
          // na hora, senao o mic fica com o LED aceso preso por uma sessao
          // fantasma que ninguem mais referencia.
          stream.getTracks().forEach((track) => track.stop());
          ws.close();
          return;
        }

        streamRef.current = stream;

        const inputContext = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
        inputContextRef.current = inputContext;

        const source = inputContext.createMediaStreamSource(stream);

        // Processa cada chunk de audio do microfone -- chamado tanto pelo
        // AudioWorklet (caminho normal) quanto pelo fallback ScriptProcessorNode
        // (se o worklet nao carregar), entao o comportamento e identico nos dois.
        const handleAudioChunk = (input: Float32Array) => {
          // Roda independente de mute/vez-de-falar: e a sala fazendo barulho
          // de verdade que prova que tem alguem ali, nao "chunk foi enviado"
          // (que so aconteceria quando ja nao esta mutado nem e a vez da IA).
          if (hasVoiceActivity(input)) {
            armUserSilenceWatchdog();
          }

          if (mutedRef.current || isAiSpeakingRef.current || ws.readyState !== WebSocket.OPEN) return;
          const pcm = floatToInt16(input);
          ws.send(pcm.buffer as ArrayBuffer);
          // NAO rearma o watchdog de "travou" aqui -- isso e chamado a cada
          // ~250ms enquanto o usuario fala, e rearmar em todo chunk fazia o
          // timer de 20s nunca completar enquanto a pessoa continuasse falando
          // esperando resposta (bug real, achado com HAR: 112s de silencio
          // do Gemini e o watchdog nunca disparou). Agora so arma quando um
          // turno termina (ver "turn_complete"/"interrupted" abaixo) e no
          // ws.onopen -- representa "tempo desde a ultima resposta", nao
          // "tempo desde o ultimo audio enviado".
        };

        // AudioWorklet roda em thread propria, dedicada, imune a engasgo da
        // main thread -- ScriptProcessorNode (deprecated) roda na main thread
        // junto com o React. Se o worklet nao carregar por qualquer motivo
        // (navegador antigo, addModule falhar), cai pro ScriptProcessorNode
        // de antes em vez de derrubar a sessao -- fala com a IA continua
        // funcionando, so perde o isolamento de thread.
        try {
          await inputContext.audioWorklet.addModule("/mic-processor.worklet.js");
          const workletNode = new AudioWorkletNode(inputContext, "mic-processor", {
            processorOptions: { chunkSize: 4096 },
          });
          workletNodeRef.current = workletNode;
          workletNode.port.onmessage = (event) => {
            handleAudioChunk(event.data as Float32Array);
          };
          source.connect(workletNode);
          workletNode.connect(inputContext.destination);
        } catch (err) {
          console.warn("AudioWorklet indisponivel, usando fallback ScriptProcessorNode:", err);
          const processor = inputContext.createScriptProcessor(4096, 1, 1);
          processorRef.current = processor;
          processor.onaudioprocess = (event) => {
            handleAudioChunk(event.inputBuffer.getChannelData(0));
          };
          source.connect(processor);
          processor.connect(inputContext.destination);
        }
      } catch {
        // Sem acesso ao microfone (permissao negada, sem dispositivo, etc)
        // a sessao nao serve pra nada -- encerra e mostra erro em vez de
        // ficar preso mostrando "Ouvindo..." sem nunca capturar audio.
        setStatus("error");
        ws.close();
      }
    };

    ws.onmessage = (event) => {
      const context = outputContextRef.current;
      if (!context) return;

      // Qualquer coisa vinda do Gemini (audio ou controle) prova que ele
      // ainda esta vivo e respondendo -- desarma o alerta de "travou".
      clearNoResponseWatchdog();

      if (typeof event.data === "string") {
        const message = JSON.parse(event.data) as ControlMessage;

        if (message.type === "interrupted") {
          // Usuario comecou a falar por cima do Gemini -- para tudo que
          // ja estava agendado pra tocar e esvazia a fila, senao o audio
          // do turno interrompido continua saindo picado por cima do
          // audio do turno novo.
          for (const source of activeSourcesRef.current) {
            try {
              source.stop();
            } catch {
              // ja tinha terminado de tocar sozinho, tudo bem
            }
          }
          activeSourcesRef.current = [];
          playbackTimeRef.current = context.currentTime;
          isAiSpeakingRef.current = false;
          setAiSpeaking(false);
          if (speakingWatchdogRef.current) clearTimeout(speakingWatchdogRef.current);
          if (pendingGoAwayRef.current) {
            pendingGoAwayRef.current = false;
            reconnectRef.current(true);
            return;
          }
          armNoResponseWatchdog();
        }

        if (message.type === "turn_complete") {
          // A vez do Gemini acabou -- libera o microfone de novo e comeca a
          // contar os 20s de espera pela PROXIMA resposta.
          isAiSpeakingRef.current = false;
          setAiSpeaking(false);
          if (speakingWatchdogRef.current) clearTimeout(speakingWatchdogRef.current);
          if (pendingGoAwayRef.current) {
            // Go_away chegou enquanto ela falava -- so agora, com o turno
            // fechado, e seguro trocar de sessao sem cortar audio no meio.
            pendingGoAwayRef.current = false;
            reconnectRef.current(true);
            return;
          }
          armNoResponseWatchdog();
        }

        if (message.type === "go_away") {
          // Troca de sessao PROATIVA antes do Gemini derrubar de vez, usando
          // o handle de resumption -- olhando de fora, o usuario nunca
          // percebe o corte (nem aviso na tela, nem a IA comentando que
          // "voltou"). So adia se ela estiver no meio de uma fala (ver
          // pendingGoAwayRef acima).
          if (isAiSpeakingRef.current) {
            pendingGoAwayRef.current = true;
          } else {
            reconnectRef.current(true);
          }
        }

        if (message.type === "session_handle" && message.handle) {
          sessionHandleRef.current = message.handle;
        }

        return;
      }

      if (!(event.data instanceof ArrayBuffer)) return;

      // Chegou audio novo do Gemini -- ele esta com a vez de falar, entao
      // pausa o envio do microfone ate o turn_complete.
      isAiSpeakingRef.current = true;
      setAiSpeaking(true);
      armSpeakingWatchdog();

      const float32 = int16ToFloat(new Int16Array(event.data));
      const buffer = context.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
      buffer.copyToChannel(float32 as Float32Array<ArrayBuffer>, 0);

      const bufferSource = context.createBufferSource();
      bufferSource.buffer = buffer;
      bufferSource.connect(context.destination);
      bufferSource.onended = () => {
        activeSourcesRef.current = activeSourcesRef.current.filter((s) => s !== bufferSource);
      };
      activeSourcesRef.current.push(bufferSource);

      // Agenda cada pedaco de audio pra tocar em sequencia, sem sobrepor
      // nem deixar buraco de silencio entre eles.
      const now = context.currentTime;
      const startAt = Math.max(now, playbackTimeRef.current);
      bufferSource.start(startAt);
      playbackTimeRef.current = startAt + buffer.duration;
    };

    ws.onerror = () => {
      if (wsRef.current !== ws) return; // conexao antiga, ja substituida por um reconnect
      setStatus("error");
    };
    ws.onclose = () => {
      if (wsRef.current !== ws) return; // conexao antiga, ja substituida por um reconnect
      setStatus((current) => (current === "error" ? current : "closed"));
    };
  }, [missionId, token]);

  // Reconexao automatica: fecha a sessao antiga e abre uma nova com
  // resume=true (usa o handle de resumption pra restaurar o contexto real).
  // silent=true (go_away proativo) pula o prompt de "voltei" -- nada
  // quebrou da perspectiva do usuario, entao nao ha o que anunciar.
  // silent=false (watchdog de "travou") manda o prompt, porque ai sim
  // houve uma interrupcao real que vale a IA reconhecer.
  const reconnect = useCallback(
    (silent = false) => {
      stop();
      void start(true, silent);
    },
    [stop, start],
  );

  useEffect(() => {
    reconnectRef.current = reconnect;
  }, [reconnect]);

  useEffect(() => stop, [stop]);

  return {
    status,
    muted,
    toggleMute,
    start,
    stop,
    noResponse,
    endedBySilence,
    aiSpeaking,
  };
}
