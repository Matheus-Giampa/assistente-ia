import { useEffect, useState } from "react";
import { fetchMissions, ApiError } from "../api/client";
import type { Mission } from "../types/mission";
import { MissionCard } from "./MissionCard";
import { Session } from "./Session";
import { useAuth } from "../context/AuthContext";
import "./Dashboard.css";

export function Dashboard() {
  const { token, logout } = useAuth();
  const [missions, setMissions] = useState<Mission[]>([]);
  const [selected, setSelected] = useState<Mission | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;

    fetchMissions<Mission[]>(token)
      .then(setMissions)
      .catch((err) => {
        if (err instanceof ApiError && err.status === 401) {
          logout();
          return;
        }
        setError("Não foi possível carregar as missões");
      })
      .finally(() => setLoading(false));
  }, [token, logout]);

  if (selected) {
    return <Session mission={selected} onEnd={() => setSelected(null)} />;
  }

  return (
    <div className="dashboard">
      <header className="dashboard__header">
        <button className="dashboard__logout" onClick={logout}>
          Sair
        </button>
        <h1>Escolha sua missão</h1>
        <p>Simulações de conversação guiadas por IA, em tempo real.</p>
      </header>

      {loading && <p className="dashboard__status">Carregando missões...</p>}
      {error && <p className="dashboard__status dashboard__status--error">{error}</p>}

      <div className="dashboard__grid">
        {missions.map((mission) => (
          <MissionCard key={mission.id} mission={mission} onSelect={setSelected} />
        ))}
      </div>
    </div>
  );
}
