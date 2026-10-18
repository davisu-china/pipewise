import { NavLink, Outlet } from "react-router-dom";
import { Activity, FileText, Inbox, Layers, ListChecks, Wrench } from "lucide-react";
import { Toaster } from "sonner";
import { useAuth } from "@/lib/auth";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { cn } from "@/lib/utils";

const NAV = [
  { to: "/definitions", label: "流程定义", icon: Layers },
  { to: "/forms", label: "表单", icon: FileText },
  { to: "/tasks", label: "我的待办", icon: ListChecks },
  { to: "/instances", label: "实例", icon: Activity },
  { to: "/admin", label: "运维", icon: Wrench, adminOnly: true },
];

export function AppLayout() {
  const { users, token, me, switchUser, isAdmin } = useAuth();
  const current = users.find((u) => u.token === token);

  return (
    <div className="min-h-screen bg-muted/30">
      <header className="sticky top-0 z-30 border-b bg-background/90 backdrop-blur">
        <div className="container flex h-14 items-center gap-6">
          <div className="flex items-center gap-2">
            <span className="flex h-7 w-7 items-center justify-center rounded-md bg-primary text-[11px] font-bold text-primary-foreground">PW</span>
            <span className="text-base font-semibold">PipeWise</span>
            <span className="hidden text-xs text-muted-foreground sm:inline">流程引擎平台</span>
          </div>
          <nav className="flex flex-1 items-center gap-1 overflow-x-auto">
            {NAV.filter((n) => !n.adminOnly || isAdmin).map((n) => (
              <NavLink
                key={n.to}
                to={n.to}
                className={({ isActive }) =>
                  cn(
                    "flex items-center gap-1.5 whitespace-nowrap rounded-md px-3 py-1.5 text-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground",
                    isActive && "bg-secondary font-medium text-foreground",
                  )
                }
              >
                <n.icon className="h-4 w-4" />
                {n.label}
              </NavLink>
            ))}
          </nav>
          <div className="flex items-center gap-2">
            <span className="hidden text-xs text-muted-foreground sm:inline">{me ? `${me.name} · ${me.roles.join("/")}` : "未登录"}</span>
            <Select value={token} onValueChange={switchUser}>
              <SelectTrigger className="h-8 w-[170px] text-xs" aria-label="切换演示用户">
                <SelectValue placeholder="选择用户" />
              </SelectTrigger>
              <SelectContent>
                {users.map((u) => (
                  <SelectItem key={u.id} value={u.token}>
                    {u.name}（{u.roles.join("/")}）
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </header>
      {/* 切换演示用户后整页重挂载，避免沿用上一个账号已加载的数据 */}
      <main className="container py-6" key={token}>
        <Outlet />
      </main>
      <Toaster richColors position="top-center" />
    </div>
  );
}
