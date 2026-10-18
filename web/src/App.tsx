import { Navigate, Route, Routes } from "react-router-dom";
import { AlertTriangle, Loader2 } from "lucide-react";
import { useAuth } from "@/lib/auth";
import { AppLayout } from "@/components/layout/AppLayout";
import { Definitions } from "@/pages/Definitions";
import { Designer } from "@/pages/Designer";
import { Forms } from "@/pages/Forms";
import { Tasks } from "@/pages/Tasks";
import { TaskDetail } from "@/pages/TaskDetail";
import { Instances } from "@/pages/Instances";
import { InstanceDetail } from "@/pages/InstanceDetail";
import { StartFlow } from "@/pages/StartFlow";
import { Admin } from "@/pages/Admin";

function AdminRoute() {
  const { isAdmin, me } = useAuth();
  // 等 /me 返回后再判断角色，否则直接访问 /admin 会在身份回来前被误判成非管理员
  if (!me) return <div className="py-16 text-center text-sm text-muted-foreground">加载中…</div>;
  return isAdmin ? <Admin /> : <Navigate to="/definitions" replace />;
}

export default function App() {
  const { ready, error } = useAuth();

  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center text-muted-foreground">
        <Loader2 className="mr-2 h-4 w-4 animate-spin" /> 加载中…
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex min-h-screen items-center justify-center p-6">
        <div className="max-w-lg rounded-xl border bg-card p-6 shadow-sm">
          <div className="flex items-center gap-2 font-semibold">
            <AlertTriangle className="h-5 w-5 text-destructive" /> 页面初始化失败
          </div>
          <p className="mt-2 text-sm text-muted-foreground">{error}</p>
          <p className="mt-3 text-xs text-muted-foreground">
            提示：演示账号接口需要 <code className="rounded bg-muted px-1">PIPEWISE_DEMO=1</code>；整站挂在 Basic Auth
            后面时要先通过网关认证。
          </p>
        </div>
      </div>
    );
  }

  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<Navigate to="/definitions" replace />} />
        <Route path="definitions" element={<Definitions />} />
        <Route path="designer/:key" element={<Designer />} />
        <Route path="forms" element={<Forms />} />
        <Route path="tasks" element={<Tasks />} />
        <Route path="tasks/:id" element={<TaskDetail />} />
        <Route path="instances" element={<Instances />} />
        <Route path="instances/:id" element={<InstanceDetail />} />
        <Route path="start/:key" element={<StartFlow />} />
        <Route path="admin" element={<AdminRoute />} />
        <Route path="*" element={<Navigate to="/definitions" replace />} />
      </Route>
    </Routes>
  );
}
