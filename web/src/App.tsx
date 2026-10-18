import { Activity } from "lucide-react";
import { BrowserRouter, Link, Navigate, NavLink, Route, Routes } from "react-router-dom";
import DefinitionListPage from "./pages/DefinitionListPage";
import DesignerPage from "./pages/DesignerPage";
import HealthPage from "./pages/HealthPage";

function navClassName({ isActive }: { isActive: boolean }) {
  return [
    "rounded-md px-3 py-1.5 text-sm transition-colors",
    isActive ? "bg-slate-900 text-white" : "text-slate-600 hover:bg-slate-100"
  ].join(" ");
}

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen">
        <header className="border-b border-slate-200 bg-white">
          <div className="mx-auto flex max-w-6xl items-center gap-6 px-6 py-3">
            <Link to="/" className="flex items-center gap-2">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-slate-900 text-white">
                <Activity size={17} />
              </span>
              <span className="text-sm font-semibold tracking-tight">PipeWise</span>
              <span className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-500">P1</span>
            </Link>
            <nav className="flex items-center gap-1">
              <NavLink to="/" end className={navClassName}>
                流程定义
              </NavLink>
              <NavLink to="/health" className={navClassName}>
                环境自检
              </NavLink>
            </nav>
            <span className="ml-auto hidden text-xs text-slate-400 sm:block">
              定义 → 发布 → 版本
            </span>
          </div>
        </header>

        <Routes>
          <Route path="/" element={<DefinitionListPage />} />
          <Route path="/definitions/:key" element={<DesignerPage />} />
          <Route path="/health" element={<HealthPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </div>
    </BrowserRouter>
  );
}
