export type MissionMode = "interview" | "roleplay" | "teacher";

export interface Mission {
  id: string;
  mode: MissionMode;
  title: string;
  description: string;
  emoji: string;
  accent_color: string;
}
