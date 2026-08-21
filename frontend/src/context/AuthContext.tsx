import { createContext, useContext, useState, type ReactNode } from "react";
import { login as apiLogin } from "../api/client";

interface AuthContextValue {
  token: string | null;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

// TODO: localStorage e vulneravel a XSS (qualquer script injetado consegue
// ler o token). Pra producao de verdade, considerar migrar pra cookie
// httpOnly setado pelo backend -- exige o backend passar a aceitar cookie
// em vez de so header Authorization, e tratar CSRF. Aceitavel por enquanto
// nesse estagio do projeto.
const STORAGE_KEY = "assistente_ia_token";

export function AuthProvider({ children }: { children: ReactNode }) {
  const [token, setToken] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY),
  );

  async function login(email: string, password: string) {
    const { access_token } = await apiLogin(email, password);
    localStorage.setItem(STORAGE_KEY, access_token);
    setToken(access_token);
  }

  function logout() {
    localStorage.removeItem(STORAGE_KEY);
    setToken(null);
  }

  return (
    <AuthContext.Provider value={{ token, login, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    throw new Error("useAuth precisa estar dentro de um AuthProvider");
  }
  return ctx;
}
