import { useCallback, useEffect, useRef, useState } from "react";

type ConnectionStatus = "idle" | "connecting" | "open" | "closed" | "error";

// Formatos exigidos pelo Gemini Live -- ver live_session.py no backend.
const INPUT_SAMPLE_RATE = 16000;
const OUTPUT_SAMPLE_RATE = 24000;

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
  type: "interrupted" | "go_away" | "turn_complete";
  time_left?: string;
}

// Quanto tempo sem NENHUMA resposta do Gemini (audio ou sinal de controle)
// depois do usuario falar pra considerar que ele travou/parou de responder.
const NO_RESPONSE_TIMEOUT_MS = 20000;

export function useAudioSession(missionId: string, token: string) {
  const [status, setStatus] = useState<ConnectionStatus>("idle");
  const [muted, setMuted] = useState(false);
  const [goAwayWarning, setGoAwayWarning] = useState<string | null>(null);
  const [noResponse, setNoResponse] = useState(false);

  const wsRef = useRef<WebSocket | null>(null);
  const inputContextRef = useRef<AudioContext | null>(null);
  const outputContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const processorRef = useRef<ScriptProcessorNode | null>(null);
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
  const reconnectRef = useRef<() => void>(() => {});

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

  useEffect(() => {
    mutedRef.current = muted;
  }, [muted]);

  const stop = useCallback(() => {
    wsRef.current?.close();
    wsRef.current = null;

    processorRef.current?.disconnect();
    processorRef.current = null;

    streamRef.current?.getTracks().forEach((track) => track.stop());
    streamRef.current = null;

    void inputContextRef.current?.close();
    inputContextRef.current = null;

    void outputContextRef.current?.close();
    outputContextRef.current = null;

    activeSourcesRef.current = [];
    isAiSpeakingRef.current = false;
    if (speakingWatchdogRef.current) clearTimeout(speakingWatchdogRef.current);
    if (noResponseTimeoutRef.current) clearTimeout(noResponseTimeoutRef.current);
    setNoResponse(false);
    setStatus("closed");
  }, []);

  const start = useCallback(async (resume = false) => {
    setStatus("connecting");

    const apiUrl = import.meta.env.VITE_API_URL as string;
    const wsUrl = apiUrl.replace(/^http/, "ws");
    const resumeParam = resume ? "&resume=true" : "";
    const ws = new WebSocket(`${wsUrl}/ws/session/${missionId}?token=${token}${resumeParam}`);
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const outputContext = new AudioContext({ sampleRate: OUTPUT_SAMPLE_RATE });
    outputContextRef.current = outputContext;
    playbackTimeRef.current = outputContext.currentTime;

    ws.onopen = async () => {
      setStatus("open");

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
        streamRef.current = stream;

        const inputContext = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
        inputContextRef.current = inputContext;

        const source = inputContext.createMediaStreamSource(stream);
        // ScriptProcessorNode esta deprecated em favor de AudioWorklet, mas
        // funciona em todo navegador atual e evita precisar servir um arquivo
        // de worklet separado. TODO: migrar pra AudioWorklet quando sobrar
        // tempo pra polir performance (roda fora da main thread).
        const processor = inputContext.createScriptProcessor(4096, 1, 1);
        processorRef.current = processor;

        processor.onaudioprocess = (event) => {
          if (mutedRef.current || isAiSpeakingRef.current || ws.readyState !== WebSocket.OPEN) return;
          const input = event.inputBuffer.getChannelData(0);
          const pcm = floatToInt16(input);
          ws.send(pcm.buffer);
          armNoResponseWatchdog();
        };

        source.connect(processor);
        processor.connect(inputContext.destination);
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
          if (speakingWatchdogRef.current) clearTimeout(speakingWatchdogRef.current);
        }

        if (message.type === "turn_complete") {
          // A vez do Gemini acabou -- libera o microfone de novo.
          isAiSpeakingRef.current = false;
          if (speakingWatchdogRef.current) clearTimeout(speakingWatchdogRef.current);
        }

        if (message.type === "go_away") {
          setGoAwayWarning(message.time_left ?? "em breve");
        }

        return;
      }

      if (!(event.data instanceof ArrayBuffer)) return;

      // Chegou audio novo do Gemini -- ele esta com a vez de falar, entao
      // pausa o envio do microfone ate o turn_complete.
      isAiSpeakingRef.current = true;
      armSpeakingWatchdog();

      const float32 = int16ToFloat(new Int16Array(event.data));
      const buffer = context.createBuffer(1, float32.length, OUTPUT_SAMPLE_RATE);
      buffer.copyToChannel(float32, 0);

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

  // Reconexao automatica quando o watchdog de "travou" estoura: fecha a
  // sessao morta e abre uma nova com resume=true, que injeta o prompt
  // barato de retomada em vez de reprocessar o audio todo (Cheap Prompting
  // do briefing original).
  const reconnect = useCallback(() => {
    stop();
    void start(true);
  }, [stop, start]);

  useEffect(() => {
    reconnectRef.current = reconnect;
  }, [reconnect]);

  useEffect(() => stop, [stop]);

  return { status, muted, setMuted, start, stop, goAwayWarning, noResponse };
}
