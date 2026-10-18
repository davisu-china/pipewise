import { useState } from "react";
import { Activity } from "lucide-react";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from "react-router-dom";
import DefinitionListPage from "./pages/DefinitionListPage";
import DesignerPage from "./pages/DesignerPage";
import HealthPage from "./pages/HealthPage";
import InstanceDetailPage from "./pages/InstanceDetailPage";
import InstanceListPage from "./pages/InstanceListPage";
import TaskListPage from "./pages/TaskListPage";

function navClassName({ isActive }: { isActive: boolean }) {
  return [
    "rounded-md px-3 py-1.5 text-sm transition-colors",
    isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
  ].join(" ");
}

export default function App() {
  const [user, setUser] = useState(
    typeof localStorage !== "undefined" ? localStorage.getItem("pipewise.user") || "anonymous" : "anonymous"
  );
  const [userInput, setUserInput] = useState(user);

  const commitUser = () => {
    const next = userInput.trim() || "anonymous";
    localStorage.setItem("pipewise.user", next);
    setUser(next);
    setUserInput(next);
  };

  return (
    <BrowserRouter>
      <div className="min-h-screen">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center gap-5 px-6 py-3">
            <Link to="/" className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white">
                <Activity size={17} />
              </span>
              <span className="text-sm font-semibold tracking-tight">PipeWise</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">P2</span>
            </Link>
            <nav className="flex items-center gap-1">
              <NavLink to="/" end className={navClassName}>流程定义</NavLink>
              <NavLink to="/instances" className={navClassName}>实例</NavLink>
              <NavLink to="/tasks" className={navClassName}>我的待办</NavLink>
              <NavLink to="/health" className={navClassName}>环境自检</NavLink>
            </nav>
            <label className="ml-auto flex items-center gap-2 text-xs text-slate-500">
              当前用户
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
                className="h-8 w-32 rounded-md border border-slate-200 px-2 font-mono text-xs outline-none focus:border-slate-400"
              />
            </label>
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
