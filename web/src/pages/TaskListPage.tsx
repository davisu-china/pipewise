import { useCallback, useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Inbox, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { api, type TaskView } from "../lib/api";

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export default function TaskListPage() {
  const [tasks, setTasks] = useState<TaskView[]>([]);
  const [comments, setComments] = useState<Record<number, string>>({});
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const user = typeof localStorage !== "undefined"
    ? localStorage.getItem("pipewise.user") || "anonymous"
    : "anonymous";

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listTasks("CREATED");
      if (response.success && response.data) {
        setTasks(response.data);
      } else {
        setError(response.error?.message ?? "加载待办失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 3000);
    return () => window.clearInterval(timer);
  }, [load]);

  const complete = async (task: TaskView, verdict: "approve" | "reject" | "return") => {
    setBusyId(task.id);
    setError(null);
    setMessage(null);
    try {
      const response = await api.completeTask(task.id, verdict, comments[task.id] ?? "");
      if (response.success) {
        const label = verdict === "approve" ? "同意" : verdict === "reject" ? "驳回" : "退回";
        setMessage(`任务 #${task.id} 已${label}`);
        setTasks((current) => current.filter((item) => item.id !== task.id));
      } else {
        setError(response.error?.message ?? "处理失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "处理失败");
    } finally {
      setBusyId(null);
    }
  };

  const addSign = async (task: TaskView) => {
    const assignee = window.prompt("加签给谁（用户 ID）", "");
    if (!assignee || !assignee.trim()) return;
    setBusyId(task.id);
    setError(null);
    try {
      const response = await api.addSign(task.id, assignee.trim());
      if (response.success) {
        setMessage(`已加签给 ${assignee.trim()}`);
        await load();
      } else {
        setError(response.error?.message ?? "加签失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加签失败");
    } finally {
      setBusyId(null);
    }
  };

  const transfer = async (task: TaskView) => {
    const assignee = window.prompt("转交给谁（用户 ID）", "");
    if (!assignee || !assignee.trim()) return;
    setBusyId(task.id);
    setError(null);
    try {
      const response = await api.transfer(task.id, assignee.trim());
      if (response.success) {
        setMessage(`任务已转交给 ${assignee.trim()}`);
        setTasks((current) => current.filter((item) => item.id !== task.id));
      } else {
        setError(response.error?.message ?? "转交失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "转交失败");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">我的待办</h2>
          <p className="mt-1 text-sm text-slate-500">
            当前用户：<span className="font-mono text-slate-700">{user}</span> · 每 3 秒自动刷新
          </p>
        </div>
        <Button className="h-9 bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => void load()}>
          <RefreshCw size={15} /> 刷新
        </Button>
      </div>

      {message && (
        <div className="mb-4 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-700">{message}</div>
      )}
      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <Card>
        <CardContent className="p-0">
          {loading && tasks.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-slate-500">加载中…</div>
          ) : tasks.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-5 py-14 text-center">
              <Inbox size={28} className="text-slate-300" />
              <p className="text-sm text-slate-500">当前没有待办。切换右上角用户可查看其他人的任务。</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {tasks.map((task) => (
                <div key={task.id} className="grid gap-3 px-5 py-4 lg:grid-cols-[1.2fr_1fr_1.4fr_auto] lg:items-center">
                  <div>
                    <div className="text-sm font-medium text-slate-900">{task.title ?? `任务 #${task.id}`}</div>
                    <div className="mt-0.5 text-xs text-slate-500">
                      <Link to={`/instances/${task.instanceId}`} className="font-mono underline-offset-4 hover:underline">
                        {task.instanceId}
                      </Link>
                      <span className="ml-2 font-mono text-slate-400">{task.nodeId}</span>
                    </div>
                  </div>
                  <div className="text-xs text-slate-500">
                    <div>处理人：{task.assignee}</div>
                    <div>{formatDate(task.createdAt)}</div>
                  </div>
                  <input
                    value={comments[task.id] ?? ""}
                    onChange={(event) => setComments({ ...comments, [task.id]: event.target.value })}
                    placeholder="审批意见（可选）"
                    className="h-9 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                  />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      className="h-9 bg-emerald-700 hover:bg-emerald-600"
                      disabled={busyId === task.id}
                      onClick={() => void complete(task, "approve")}
                    >
                      同意
                    </Button>
                    <Button
                      className="h-9 bg-red-700 hover:bg-red-600"
                      disabled={busyId === task.id}
                      onClick={() => void complete(task, "reject")}
                    >
                      驳回
                    </Button>
                    <Button
                      className="h-9 bg-amber-700 hover:bg-amber-600"
                      disabled={busyId === task.id}
                      onClick={() => void complete(task, "return")}
                    >
                      退回
                    </Button>
                    <Button
                      className="h-9 bg-slate-600 hover:bg-slate-500"
                      disabled={busyId === task.id}
                      onClick={() => void addSign(task)}
                    >
                      加签
                    </Button>
                    <Button
                      className="h-9 bg-slate-600 hover:bg-slate-500"
                      disabled={busyId === task.id}
                      onClick={() => void transfer(task)}
                    >
                      转交
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
