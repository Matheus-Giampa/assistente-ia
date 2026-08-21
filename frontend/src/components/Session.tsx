import { useEffect, type CSSProperties } from "react";
import { useAuth } from "../context/AuthContext";
import { useAudioSession } from "../hooks/useAudioSession";
import type { Mission } from "../types/mission";
import "./Session.css";

interface SessionProps {
  mission: Mission;
  onEnd: () => void;
}

export function Session({ mission, onEnd }: SessionProps) {
  const { token } = useAuth();
  const { status, muted, setMuted, start, stop } = useAudioSession(mission.id, token ?? "");

  useEffect(() => {
    void start();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleEnd() {
    stop();
    onEnd();
  }

  return (
    <div className="session">
      <div
        className="session__mission"
        style={{ "--accent-color": mission.accent_color } as CSSProperties}
      >
        <span className="session__emoji">{mission.emoji}</span>
        <h2>{mission.title}</h2>
      </div>

      <div className={`session__orb session__orb--${status}`} />

      <p className="session__status">
        {status === "connecting" && "Conectando..."}
        {status === "open" && (muted ? "Microfone mudo" : "Ouvindo...")}
        {status === "error" && "Erro: verifique a permissão do microfone ou a conexão"}
        {status === "closed" && "Sessão encerrada"}
      </p>

      <div className="session__controls">
        <button
          className="session__mute"
          onClick={() => setMuted((current) => !current)}
          disabled={status !== "open"}
        >
          {muted ? "Ativar microfone" : "Mutar"}
        </button>
        <button className="session__end" onClick={handleEnd}>
          Encerrar
        </button>
      </div>
    </div>
  );
}
