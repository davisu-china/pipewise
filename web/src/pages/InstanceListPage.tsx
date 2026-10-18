import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ListChecks, Plus, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { api, type DefinitionSummary, type InstanceSummary } from "../lib/api";

const statusStyles: Record<string, string> = {
  RUNNING: "bg-blue-100 text-blue-700",
  COMPLETED: "bg-emerald-100 text-emerald-700",
  SUSPENDED: "bg-amber-100 text-amber-700",
  TERMINATED: "bg-slate-100 text-slate-600",
  FAILED: "bg-red-100 text-red-700"
};

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export default function InstanceListPage() {
  const navigate = useNavigate();
  const [definitions, setDefinitions] = useState<DefinitionSummary[]>([]);
  const [instances, setInstances] = useState<InstanceSummary[]>([]);
  const [status, setStatus] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    key: "",
    businessKey: "",
    title: "",
    initiator: typeof localStorage !== "undefined" ? localStorage.getItem("pipewise.user") || "anonymous" : "anonymous"
  });

  const load = useCallback(async (filter = status) => {
    setLoading(true);
    setError(null);
    try {
      const [definitionsResponse, instancesResponse] = await Promise.all([
        api.listDefinitions(),
        api.listInstances(filter || undefined)
      ]);
      if (definitionsResponse.success && definitionsResponse.data) {
        setDefinitions(definitionsResponse.data);
        if (!form.key && definitionsResponse.data.length > 0) {
          setForm((current) => ({ ...current, key: definitionsResponse.data![0].key }));
        }
      }
      if (instancesResponse.success && instancesResponse.data) {
        setInstances(instancesResponse.data);
      } else {
        setError(instancesResponse.error?.message ?? "加载实例失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [status, form.key]);

  useEffect(() => {
    void load("");
    const timer = window.setInterval(() => void load(status), 4000);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api.createInstance({
        key: form.key,
        businessKey: form.businessKey.trim(),
        title: form.title.trim() || undefined,
        initiator: form.initiator.trim() || undefined
      });
      if (response.success && response.data) {
        navigate(`/instances/${response.data.summary.id}`);
      } else {
        setError(response.error?.message ?? "发起失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发起失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">流程实例</h2>
          <p className="mt-1 text-sm text-slate-500">
            发起实例、查看当前节点与时间线。状态每 4 秒自动刷新。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              void load(event.target.value);
            }}
            className="h-9 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-slate-400"
          >
            <option value="">全部状态</option>
            <option value="RUNNING">RUNNING</option>
            <option value="COMPLETED">COMPLETED</option>
            <option value="TERMINATED">TERMINATED</option>
            <option value="FAILED">FAILED</option>
          </select>
          <Button className="h-9 bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => void load(status)}>
            <RefreshCw size={15} />
            刷新
          </Button>
          <Button className="h-9" onClick={() => setShowCreate((value) => !value)}>
            <Plus size={15} />
            发起实例
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      {showCreate && (
        <Card className="mb-5">
          <CardContent className="pt-5">
            <form onSubmit={submit} className="grid gap-3 lg:grid-cols-[1fr_1fr_1fr_1fr_auto] lg:items-end">
              <label className="grid gap-1 text-xs text-slate-600">
                流程定义
                <select
                  required
                  value={form.key}
                  onChange={(event) => setForm({ ...form, key: event.target.value })}
                  className="h-9 rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-slate-400"
                >
                  <option value="" disabled>选择已发布流程</option>
                  {definitions.map((definition) => (
                    <option key={definition.id} value={definition.key}>
                      {definition.name}（{definition.key}）
                    </option>
                  ))}
                </select>
              </label>
              <label className="grid gap-1 text-xs text-slate-600">
                业务键 businessKey
                <input
                  required
                  value={form.businessKey}
                  onChange={(event) => setForm({ ...form, businessKey: event.target.value })}
                  placeholder="LEAVE-2026-001"
                  className="h-9 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                />
              </label>
              <label className="grid gap-1 text-xs text-slate-600">
                标题
                <input
                  value={form.title}
                  onChange={(event) => setForm({ ...form, title: event.target.value })}
                  placeholder="张三的请假申请"
                  className="h-9 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                />
              </label>
              <label className="grid gap-1 text-xs text-slate-600">
                发起人
                <input
                  value={form.initiator}
                  onChange={(event) => setForm({ ...form, initiator: event.target.value })}
                  className="h-9 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                />
              </label>
              <Button type="submit" disabled={busy} className="h-9">
                {busy ? "发起中…" : "发起"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {loading && instances.length === 0 ? (
            <div className="px-5 py-12 text-center text-sm text-slate-500">加载中…</div>
          ) : instances.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-5 py-14 text-center">
              <ListChecks size={28} className="text-slate-300" />
              <p className="text-sm text-slate-500">还没有实例，点击右上角「发起实例」。</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-5 py-3 font-medium">标题</th>
                  <th className="px-5 py-3 font-medium">业务键</th>
                  <th className="px-5 py-3 font-medium">流程</th>
                  <th className="px-5 py-3 font-medium">状态</th>
                  <th className="px-5 py-3 font-medium">当前节点</th>
                  <th className="px-5 py-3 font-medium">发起人</th>
                  <th className="px-5 py-3 font-medium">创建时间</th>
                  <th className="px-5 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {instances.map((instance) => (
                  <tr key={instance.id} className="border-b last:border-0 hover:bg-slate-50/60">
                    <td className="px-5 py-3 font-medium text-slate-900">{instance.title ?? "—"}</td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-500">{instance.businessKey}</td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-500">{instance.definitionKey} v{instance.version}</td>
                    <td className="px-5 py-3">
                      <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${statusStyles[instance.status] ?? "bg-slate-100 text-slate-600"}`}>
                        {instance.status}
                        {instance.outcome ? ` · ${instance.outcome}` : ""}
                      </span>
                    </td>
                    <td className="px-5 py-3">
                      <div className="flex flex-wrap gap-1">
                        {instance.currentNodeIds.length === 0 ? (
                          <span className="text-xs text-slate-400">—</span>
                        ) : instance.currentNodeIds.map((nodeId) => (
                          <span key={nodeId} className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[11px] text-slate-600">
                            {nodeId}
                          </span>
                        ))}
                      </div>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-600">{instance.initiator}</td>
                    <td className="px-5 py-3 text-xs text-slate-500">{formatDate(instance.createdAt)}</td>
                    <td className="px-5 py-3 text-right">
                      <Link to={`/instances/${instance.id}`} className="text-sm font-medium text-slate-900 underline-offset-4 hover:underline">
                        查看
                      </Link>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
