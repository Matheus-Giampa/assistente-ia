import type { Mission } from "../types/mission";

// Lista estatica por enquanto (frontend puro, sem backend).
// TODO: quando o backend tiver a tabela de missoes, isso vira um fetch
// pra GET /missions em vez de array hardcoded.
export const missions: Mission[] = [
  {
    id: "interview",
    mode: "interview",
    title: "Entrevista de Emprego",
    description:
      "Simulacao com recrutador senior de TI. Perguntas tecnicas e comportamentais, ambiente formal com cronometro.",
    emoji: "\u{1F4BC}",
    accentColor: "#3b82f6",
  },
  {
    id: "cafe-ny",
    mode: "roleplay",
    title: "Cafeteria em Nova York",
    description:
      "Voce e um turista tentando pedir um cafe numa cafeteria lotada de Manhattan. O atendente fala rapido e nao sai do personagem.",
    emoji: "☕",
    accentColor: "#f59e0b",
  },
  {
    id: "english-teacher",
    mode: "teacher",
    title: "Professor de Ingles",
    description:
      "Aula particular com professor nativo. Correcao didatica de gramatica, vocabulario e pronuncia em tempo real.",
    emoji: "\u{1F393}",
    accentColor: "#10b981",
  },
];
