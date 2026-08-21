const API_URL = import.meta.env.VITE_API_URL as string;

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(`${API_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options.headers,
    },
  });

  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new ApiError(response.status, body?.detail ?? "Erro desconhecido");
  }

  return response.json() as Promise<T>;
}

interface LoginResponse {
  access_token: string;
  token_type: string;
}

export function login(email: string, password: string): Promise<LoginResponse> {
  return request<LoginResponse>("/login", {
    method: "POST",
    body: JSON.stringify({ email, password }),
  });
}

export function fetchMissions<T>(token: string): Promise<T> {
  return request<T>("/missions", {
    headers: { Authorization: `Bearer ${token}` },
  });
}

interface WsTicketResponse {
  ticket: string;
}

export async function createWsTicket(token: string): Promise<string> {
  const { ticket } = await request<WsTicketResponse>("/ws-ticket", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}` },
  });
  return ticket;
}

export interface LoginEvent {
  email: string;
  success: boolean;
  ip_address: string | null;
  created_at: string;
}

export function fetchLoginEvents(token: string): Promise<LoginEvent[]> {
  return request<LoginEvent[]>("/login-events", {
    headers: { Authorization: `Bearer ${token}` },
  });
}
