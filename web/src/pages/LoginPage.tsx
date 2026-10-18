import { useState, type FormEvent } from "react";
import { Activity, LogIn } from "lucide-react";
import { Button } from "../components/ui/button";
import { api } from "../lib/api";

export default function LoginPage({ onLogin }: { onLogin: (username: string) => void }) {
  const [username, setUsername] = useState("pipewise");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api.login(username.trim(), password);
      if (response.success && response.data) {
        onLogin(response.data.username);
      } else {
        setError(response.error?.message ?? "登录失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-screen items-center justify-center bg-slate-50 px-4">
      <div className="w-full max-w-sm rounded-xl border border-slate-200 bg-white p-7 shadow-sm">
        <div className="mb-6 flex items-center gap-3">
          <span className="flex h-10 w-10 items-center justify-center rounded-lg bg-slate-900 text-white">
            <Activity size={20} />
          </span>
          <div>
            <h1 className="text-lg font-semibold tracking-tight">PipeWise</h1>
            <p className="text-xs text-slate-500">流程引擎平台 · P3</p>
          </div>
        </div>

        <form onSubmit={submit} className="space-y-4">
          <label className="grid gap-1.5 text-xs text-slate-600">
            用户名
            <input
              required
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              className="h-10 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
            />
          </label>
          <label className="grid gap-1.5 text-xs text-slate-600">
            密码
            <input
              required
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoFocus
              className="h-10 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
            />
          </label>
          {error && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {error}
            </div>
          )}
          <Button type="submit" disabled={busy} className="h-10 w-full">
            <LogIn size={16} />
            {busy ? "登录中…" : "登录"}
          </Button>
        </form>

        <p className="mt-5 text-center text-[11px] text-slate-400">
          登录一次后 7 天内保持登录状态
        </p>
      </div>
    </div>
  );
}
