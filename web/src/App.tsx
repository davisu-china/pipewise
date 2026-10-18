import { useEffect, useState } from "react";
import { Activity } from "lucide-react";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from "react-router-dom";
import { api } from "./lib/api";
import DefinitionListPage from "./pages/DefinitionListPage";
import DesignerPage from "./pages/DesignerPage";
import HealthPage from "./pages/HealthPage";
import InstanceDetailPage from "./pages/InstanceDetailPage";
import InstanceListPage from "./pages/InstanceListPage";
import LoginPage from "./pages/LoginPage";
import TaskListPage from "./pages/TaskListPage";

type AuthState = "checking" | "authenticated" | "anonymous";

function navClassName({ isActive }: { isActive: boolean }) {
  return [
    "rounded-md px-3 py-1.5 text-sm transition-colors",
    isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
  ].join(" ");
}

export default function App() {
  const [authState, setAuthState] = useState<AuthState>("checking");
  const [authUser, setAuthUser] = useState("");
  const [user, setUser] = useState(
    typeof localStorage !== "undefined" ? localStorage.getItem("pipewise.user") || "anonymous" : "anonymous"
  );
  const [userInput, setUserInput] = useState(user);
  const basename = import.meta.env.BASE_URL === "/" ? "/" : import.meta.env.BASE_URL.replace(/\/$/, "");

  useEffect(() => {
    let active = true;
    api.me()
      .then((response) => {
        if (!active) return;
        if (response.success && response.data) {
          setAuthUser(response.data.username);
          setAuthState("authenticated");
        } else {
          setAuthState("anonymous");
        }
      })
      .catch(() => {
        if (active) setAuthState("anonymous");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const handler = () => setAuthState("anonymous");
    window.addEventListener("pw-unauthorized", handler);
    return () => window.removeEventListener("pw-unauthorized", handler);
  }, []);

  const commitUser = () => {
    const next = userInput.trim() || "anonymous";
    localStorage.setItem("pipewise.user", next);
    setUser(next);
    setUserInput(next);
  };

  const logout = async () => {
    try {
      await api.logout();
    } finally {
      setAuthUser("");
      setAuthState("anonymous");
    }
  };

  if (authState === "checking") {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 text-sm text-slate-500">
        正在检查登录状态…
      </div>
    );
  }

  if (authState === "anonymous") {
    return (
      <LoginPage
        onLogin={(username) => {
          setAuthUser(username);
          setAuthState("authenticated");
        }}
      />
    );
  }

  return (
    <BrowserRouter basename={basename}>
      <div className="min-h-screen">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center gap-5 px-6 py-3">
            <Link to="/" className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white">
                <Activity size={17} />
              </span>
              <span className="text-sm font-semibold tracking-tight">PipeWise</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">P3</span>
            </Link>
            <nav className="flex items-center gap-1">
              <NavLink to="/" end className={navClassName}>流程定义</NavLink>
              <NavLink to="/instances" className={navClassName}>实例</NavLink>
              <NavLink to="/tasks" className={navClassName}>我的待办</NavLink>
              <NavLink to="/health" className={navClassName}>环境自检</NavLink>
            </nav>
            <label className="ml-auto flex items-center gap-2 text-xs text-slate-500">
              操作人
              <input
                value={userInput}
                onChange={(event) => setUserInput(event.target.value)}
                onBlur={commitUser}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    commitUser();
                    (event.target as HTMLInputElement).blur();
                  }
                }}
                className="h-8 w-28 rounded-md border border-slate-200 px-2 font-mono text-xs outline-none focus:border-slate-400"
              />
            </label>
            <span className="text-xs text-slate-400">登录：{authUser}</span>
            <button
              type="button"
              onClick={() => void logout()}
              className="text-xs text-slate-500 underline-offset-4 hover:text-slate-900 hover:underline"
            >
              退出
            </button>
          </div>
        </header>

        <Routes key={user}>
          <Route path="/" element={<DefinitionListPage />} />
          <Route path="/definitions/:key" element={<DesignerPage />} />
          <Route path="/instances" element={<InstanceListPage />} />
          <Route path="/instances/:id" element={<InstanceDetailPage />} />
          <Route path="/tasks" element={<TaskListPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
