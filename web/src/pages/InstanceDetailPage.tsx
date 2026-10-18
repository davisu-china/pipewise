import { useCallback, useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, RefreshCw } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { api, type InstanceDetail } from "../lib/api";

const statusStyles: Record<string, string> = {
  RUNNING: "bg-blue-100 text-blue-700",
  COMPLETED: "bg-emerald-100 text-emerald-700",
  SUSPENDED: "bg-amber-100 text-amber-700",
  TERMINATED: "bg-slate-100 text-slate-600",
  FAILED: "bg-red-100 text-red-700"
};

function formatDate(value: string | null) {
  return value ? new Date(value).toLocaleString("zh-CN", { hour12: false }) : "—";
}

export default function InstanceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<InstanceDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      const response = await api.getInstance(id);
      if (response.success && response.data) {
        setDetail(response.data);
        setError(null);
      } else {
        setError(response.error?.message ?? "加载失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => {
      if (detail?.summary.status === "RUNNING") {
        void load();
      }
    }, 2000);
    return () => window.clearInterval(timer);
  }, [load, detail?.summary.status]);

  const withdraw = async () => {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.withdrawInstance(id);
      if (response.success) {
        await load();
      } else {
        setError(response.error?.message ?? "撤回失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "撤回失败");
    } finally {
      setBusy(false);
    }
  };

  if (loading && !detail) {
    return <main className="p-8 text-sm text-slate-500">加载实例中…</main>;
  }
  if (error && !detail) {
    return (
      <main className="p-8">
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
        <Link to="/instances" className="mt-4 inline-flex items-center gap-1 text-sm text-slate-600 underline">
          <ArrowLeft size={14} /> 返回实例列表
        </Link>
      </main>
    );
  }
  if (!detail) return null;

  const summary = detail.summary;

  return (
    <main className="mx-auto max-w-5xl px-6 py-8">
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <Link to="/instances" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-900">
          <ArrowLeft size={14} /> 实例列表
        </Link>
        <span className="font-mono text-xs text-slate-400">{summary.id}</span>
        <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${statusStyles[summary.status] ?? "bg-slate-100 text-slate-600"}`}>
          {summary.status}{summary.outcome ? ` · ${summary.outcome}` : ""}
        </span>
        <div className="ml-auto flex items-center gap-2">
          {summary.status === "RUNNING" && (
            <Button className="h-8 bg-amber-700 hover:bg-amber-600" disabled={busy} onClick={() => void withdraw()}>
              撤回
            </Button>
          )}
          <Button className="h-8 bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => void load()}>
            <RefreshCw size={14} /> 刷新
          </Button>
        </div>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>
      )}

      <div className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>基本信息</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-3 text-sm">
              <div><dt className="text-xs text-slate-400">标题</dt><dd className="font-medium">{summary.title ?? "—"}</dd></div>
              <div><dt className="text-xs text-slate-400">业务键</dt><dd className="font-mono text-xs">{summary.businessKey}</dd></div>
              <div><dt className="text-xs text-slate-400">流程</dt><dd className="font-mono text-xs">{summary.definitionKey} v{summary.version}</dd></div>
              <div><dt className="text-xs text-slate-400">发起人</dt><dd>{summary.initiator}</dd></div>
              <div><dt className="text-xs text-slate-400">创建时间</dt><dd className="text-xs">{formatDate(summary.createdAt)}</dd></div>
              <div><dt className="text-xs text-slate-400">结束时间</dt><dd className="text-xs">{formatDate(summary.endedAt)}</dd></div>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>当前节点</CardTitle></CardHeader>
          <CardContent>
            {detail.nodes.length === 0 ? (
              <p className="text-sm text-slate-400">无活动节点</p>
            ) : (
              <ul className="space-y-2">
                {detail.nodes.map((node) => (
                  <li key={node.id} className="rounded-md border border-slate-100 px-3 py-2">
                    <div className="flex items-center justify-between">
                      <span className="font-mono text-xs text-slate-700">{node.nodeId}</span>
                      <span className="text-[11px] text-slate-500">{node.status}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-slate-400">{node.nodeType}</div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader><CardTitle>任务</CardTitle></CardHeader>
          <CardContent className="p-0">
            {detail.tasks.length === 0 ? (
              <p className="px-5 pb-5 text-sm text-slate-400">暂无任务</p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-slate-50 text-left text-xs text-slate-500">
                    <th className="px-4 py-2 font-medium">节点</th>
                    <th className="px-4 py-2 font-medium">处理人</th>
                    <th className="px-4 py-2 font-medium">状态</th>
                    <th className="px-4 py-2 font-medium">结论</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.tasks.map((task) => (
                    <tr key={task.id} className="border-b last:border-0">
                      <td className="px-4 py-2 font-mono text-xs">{task.nodeId}</td>
                      <td className="px-4 py-2 text-xs">{task.assignee}</td>
                      <td className="px-4 py-2 text-xs">{task.status}</td>
                      <td className="px-4 py-2 text-xs">{task.verdict ?? "—"}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader><CardTitle>变量</CardTitle></CardHeader>
          <CardContent>
            {Object.keys(detail.variables).length === 0 ? (
              <p className="text-sm text-slate-400">暂无变量</p>
            ) : (
              <dl className="space-y-2 text-sm">
                {Object.entries(detail.variables).map(([name, value]) => (
                  <div key={name} className="flex items-start justify-between gap-3">
                    <dt className="font-mono text-xs text-slate-500">{name}</dt>
                    <dd className="break-all text-right font-mono text-xs text-slate-700">{JSON.stringify(value)}</dd>
                  </div>
                ))}
              </dl>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-4">
        <CardHeader><CardTitle>时间线</CardTitle></CardHeader>
        <CardContent>
          {detail.timeline.length === 0 ? (
            <p className="text-sm text-slate-400">暂无记录</p>
          ) : (
            <ol className="space-y-3">
              {detail.timeline.map((item, index) => (
                <li key={`${item.createdAt}-${index}`} className="flex gap-3 text-sm">
                  <span className="mt-1 h-2 w-2 shrink-0 rounded-full bg-slate-300" />
                  <div>
                    <div className="font-medium text-slate-800">
                      {item.action}
                      <span className="ml-2 font-normal text-slate-400">by {item.actor}</span>
                    </div>
                    <div className="text-xs text-slate-400">{formatDate(item.createdAt)}</div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
