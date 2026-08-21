import { useEffect, useState } from "react";
import { fetchLoginEvents, type LoginEvent } from "../api/client";
import { useAuth } from "../context/AuthContext";
import "./LoginLog.css";

interface LoginLogProps {
  onBack: () => void;
}

export function LoginLog({ onBack }: LoginLogProps) {
  const { token } = useAuth();
  const [events, setEvents] = useState<LoginEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!token) return;
    fetchLoginEvents(token)
      .then(setEvents)
      .catch(() => setError("Não foi possível carregar o log"))
      .finally(() => setLoading(false));
  }, [token]);

  return (
    <div className="login-log">
      <header className="login-log__header">
        <button className="login-log__back" onClick={onBack}>
          ← Voltar
        </button>
        <h1>Log de acessos</h1>
        <p>Últimas tentativas de login (sucesso e falha).</p>
      </header>

      {loading && <p className="login-log__status">Carregando...</p>}
      {error && <p className="login-log__status login-log__status--error">{error}</p>}

      {!loading && !error && (
        <table className="login-log__table">
          <thead>
            <tr>
              <th>Quando</th>
              <th>Email</th>
              <th>IP</th>
              <th>Resultado</th>
            </tr>
          </thead>
          <tbody>
            {events.map((e, i) => (
              <tr key={i}>
                <td>{new Date(e.created_at).toLocaleString("pt-BR")}</td>
                <td>{e.email}</td>
                <td>{e.ip_address ?? "—"}</td>
                <td>
                  <span
                    className={
                      e.success ? "login-log__badge login-log__badge--ok" : "login-log__badge login-log__badge--fail"
                    }
                  >
                    {e.success ? "sucesso" : "falha"}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
