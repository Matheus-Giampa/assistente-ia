import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useAuth } from "../context/AuthContext";
import { useAudioSession } from "../hooks/useAudioSession";
import type { Mission } from "../types/mission";
import "./Session.css";

interface SessionProps {
  mission: Mission;
  onEnd: () => void;
}

const CAFE_CHECKLIST = [
  "Tamanho da bebida",
  "Pra viagem ou pra tomar aqui?",
  "Forma de pagamento",
  "Nome pro pedido",
];

export function Session({ mission, onEnd }: SessionProps) {
  const { token } = useAuth();
  const {
    status,
    muted,
    toggleMute,
    start,
    stop,
    noResponse,
    endedBySilence,
    aiSpeaking,
  } = useAudioSession(mission.id, token ?? "");

  // Cronometro da entrevista: comeca a contar na primeira vez que a sessao
  // abre e continua do mesmo ponto atraves de reconexoes automaticas (o
  // relogio representa o tempo real de entrevista, nao o tempo de conexao).
  const [elapsedLabel, setElapsedLabel] = useState("00:00");
  const interviewStartRef = useRef<number | null>(null);

  useEffect(() => {
    if (mission.mode !== "interview" || status !== "open") return;

    if (interviewStartRef.current === null) {
      interviewStartRef.current = Date.now();
    }

    const interval = setInterval(() => {
      const startedAt = interviewStartRef.current;
      if (startedAt === null) return;
      const totalSeconds = Math.floor((Date.now() - startedAt) / 1000);
      const minutes = String(Math.floor(totalSeconds / 60)).padStart(2, "0");
      const seconds = String(totalSeconds % 60).padStart(2, "0");
      setElapsedLabel(`${minutes}:${seconds}`);
    }, 1000);

    return () => clearInterval(interval);
  }, [mission.mode, status]);

  useEffect(() => {
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleEnd() {
    stop();
    onEnd();
  }

  return (
    <div className="session" style={{ "--accent-color": mission.accent_color } as CSSProperties}>
      <div className="session__mission">
        <span className="session__emoji">{mission.emoji}</span>
        <h2>{mission.title}</h2>
      </div>

      <div className={`session__orb session__orb--${status}`} />

      {mission.mode === "interview" && status === "open" && (
        <p className="session__timer">{elapsedLabel}</p>
      )}

      <p className="session__status">
        {status === "connecting" && "Conectando..."}
        {status === "open" &&
          (aiSpeaking ? "IA falando..." : muted ? "Microfone mudo" : "Ouvindo...")}
        {status === "error" && "Erro: verifique a permissão do microfone ou a conexão"}
        {status === "closed" && (endedBySilence ? "Sessão encerrada por inatividade" : "Sessão encerrada")}
      </p>

      {mission.mode === "roleplay" && status === "open" && (
        <div className="session__hints">
          <p className="session__hints-title">O atendente vai perguntar:</p>
          <ul>
            {CAFE_CHECKLIST.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {mission.mode === "teacher" && status === "open" && (
        <p className="session__hint-note">As correções vêm explicadas em português.</p>
      )}

      {noResponse && (
        <p className="session__warning">
          A IA parou de responder — reconectando automaticamente e retomando a conversa...
        </p>
      )}

      <div className="session__controls">
        <button className="session__mute" onClick={toggleMute} disabled={status !== "open"}>
          {muted ? "Ativar microfone" : "Mutar"}
        </button>
        <button className="session__end" onClick={handleEnd}>
          Encerrar
        </button>
      </div>
    </div>
  );
}
