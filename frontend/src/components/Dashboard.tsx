import { useState } from "react";
import { missions } from "../data/missions";
import type { Mission } from "../types/mission";
import { MissionCard } from "./MissionCard";
import "./Dashboard.css";

export function Dashboard() {
  const [selected, setSelected] = useState<Mission | null>(null);

  return (
    <div className="dashboard">
      <header className="dashboard__header">
        <h1>Escolha sua missão</h1>
        <p>Simulações de conversação guiadas por IA, em tempo real.</p>
      </header>

      <div className="dashboard__grid">
        {missions.map((mission) => (
          <MissionCard key={mission.id} mission={mission} onSelect={setSelected} />
        ))}
      </div>

      {selected && (
        <p className="dashboard__debug">
          Selecionado: {selected.title} (conexão com o backend ainda não existe)
        </p>
      )}
    </div>
  );
}
