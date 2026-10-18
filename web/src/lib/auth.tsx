import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { fetchDemoUsers, fetchMe, getToken, setToken as persistToken } from "@/lib/api";
import type { DemoUser, Me } from "@/lib/types";

interface AuthValue {
  users: DemoUser[];
  token: string;
  me: Me | null;
  ready: boolean;
  error: string | null;
  switchUser: (token: string) => void;
  isAdmin: boolean;
  isDesigner: boolean;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [users, setUsers] = useState<DemoUser[]>([]);
  const [token, setTokenState] = useState<string>(getToken());
  const [me, setMe] = useState<Me | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // 演示账号来自公开接口；拿不到就整页显示原因（白屏最难查）
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchDemoUsers();
        if (cancelled) return;
        setUsers(list);
        const current = token && list.some((u) => u.token === token) ? token : list[0]?.token || "";
        if (current !== token) setTokenState(current);
        setReady(true);
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 令牌变化就重新拉当前用户
  useEffect(() => {
    if (!token) {
      setMe(null);
      return;
    }
    let cancelled = false;
    fetchMe()
      .then((m) => !cancelled && setMe(m))
      .catch(() => !cancelled && setMe(null));
    return () => {
      cancelled = true;
    };
  }, [token]);

  const switchUser = useCallback((next: string) => {
    persistToken(next);
    setTokenState(next);
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      users,
      token,
      me,
      ready,
      error,
      switchUser,
      isAdmin: !!me?.roles.includes("admin"),
      isDesigner: !!me?.roles.includes("designer") || !!me?.roles.includes("admin"),
    }),
    [users, token, me, ready, error, switchUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth 必须在 AuthProvider 内使用");
  return ctx;
}
