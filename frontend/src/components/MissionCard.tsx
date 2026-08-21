import type { CSSProperties } from "react";
import type { Mission } from "../types/mission";
import "./MissionCard.css";

interface MissionCardProps {
  mission: Mission;
  onSelect: (mission: Mission) => void;
}

export function MissionCard({ mission, onSelect }: MissionCardProps) {
  return (
    <button
      className="mission-card"
      style={{ "--accent-color": mission.accentColor } as CSSProperties}
      onClick={() => onSelect(mission)}
    >
      <span className="mission-card__emoji">{mission.emoji}</span>
      <h3 className="mission-card__title">{mission.title}</h3>
      <p className="mission-card__description">{mission.description}</p>
      <span className="mission-card__cta">Começar →</span>
    </button>
  );
}
