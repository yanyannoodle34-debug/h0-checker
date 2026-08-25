import { useState, useEffect } from "react";
import { apiRequest } from "@/lib/queryClient";

interface AuthUser {
  id: string;
  username: string;
  role: string;
}

export function useAuth() {
  const [isAuthenticated, setIsAuthenticated] = useState<boolean>(false);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [user, setUser] = useState<AuthUser | null>(null);

  useEffect(() => {
    const stored = localStorage.getItem("h0_user");
    if (stored) {
      try {
        setUser(JSON.parse(stored));
        setIsAuthenticated(true);
      } catch {}
    }
    setIsLoading(false);
  }, []);

  const login = async (password: string, username = "admin") => {
    try {
      const res = await apiRequest("POST", "/api/auth/login", { username, password });
      const data = await res.json();
      localStorage.setItem("h0_user", JSON.stringify(data));
      setUser(data);
      setIsAuthenticated(true);
      return true;
    } catch {
      return false;
    }
  };

  const logout = () => {
    localStorage.removeItem("h0_user");
    setUser(null);
    setIsAuthenticated(false);
  };

  return { isAuthenticated, isLoading, login, logout, user };
}
