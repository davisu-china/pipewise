import { useCallback, useEffect, useState, type FormEvent } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, RefreshCw, Workflow } from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent } from "../components/ui/card";
import { api, type DefinitionSummary } from "../lib/api";

function formatDate(value: string) {
  return new Date(value).toLocaleString("zh-CN", { hour12: false });
}

export default function DefinitionListPage() {
  const navigate = useNavigate();
  const [items, setItems] = useState<DefinitionSummary[]>([]);
  const [keyword, setKeyword] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ key: "", name: "", category: "" });

  const load = useCallback(async (search = keyword) => {
    setLoading(true);
    setError(null);
    try {
      const response = await api.listDefinitions(search);
      if (response.success && response.data) {
        setItems(response.data);
      } else {
        setError(response.error?.message ?? "加载失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [keyword]);

  useEffect(() => {
    void load("");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await api.createDefinition({
        key: form.key.trim(),
        name: form.name.trim(),
        category: form.category.trim() || undefined
      });
      if (response.success && response.data) {
        navigate(`/definitions/${response.data.key}`);
      } else {
        setError(response.error?.message ?? "创建失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "创建失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-start justify-between gap-4">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">流程定义</h2>
          <p className="mt-1 text-sm text-slate-500">
            定义流程 key、编辑草稿、发布不可变版本。当前阶段支持开始 / 审批 / 排他网关 / 结束。
          </p>
        </div>
        <div className="flex items-center gap-2">
          <input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void load(keyword);
            }}
            placeholder="搜索 key 或名称"
            className="h-9 w-44 rounded-md border border-slate-200 bg-white px-3 text-sm outline-none focus:border-slate-400"
          />
          <Button className="h-9 bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => void load(keyword)}>
            <RefreshCw size={15} />
            刷新
          </Button>
          <Button className="h-9" onClick={() => setShowCreate((value) => !value)}>
            <Plus size={15} />
            新建
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
            <form onSubmit={submit} className="grid gap-3 sm:grid-cols-[1fr_1fr_1fr_auto] sm:items-end">
              <label className="grid gap-1 text-xs text-slate-600">
                流程 key
                <input
                  required
                  value={form.key}
                  onChange={(event) => setForm({ ...form, key: event.target.value })}
                  placeholder="expense_approval"
                  className="h-9 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                />
              </label>
              <label className="grid gap-1 text-xs text-slate-600">
                名称
                <input
                  required
                  value={form.name}
                  onChange={(event) => setForm({ ...form, name: event.target.value })}
                  placeholder="费用报销审批"
                  className="h-9 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                />
              </label>
              <label className="grid gap-1 text-xs text-slate-600">
                分类（可选）
                <input
                  value={form.category}
                  onChange={(event) => setForm({ ...form, category: event.target.value })}
                  placeholder="hr / finance"
                  className="h-9 rounded-md border border-slate-200 px-3 text-sm outline-none focus:border-slate-400"
                />
              </label>
              <Button type="submit" disabled={busy} className="h-9">
                {busy ? "创建中…" : "创建并进入设计器"}
              </Button>
            </form>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardContent className="p-0">
          {loading ? (
            <div className="px-5 py-12 text-center text-sm text-slate-500">加载中…</div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-3 px-5 py-14 text-center">
              <Workflow size={28} className="text-slate-300" />
              <p className="text-sm text-slate-500">还没有流程定义，点击右上角「新建」开始。</p>
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b bg-slate-50 text-left text-xs text-slate-500">
                  <th className="px-5 py-3 font-medium">名称</th>
                  <th className="px-5 py-3 font-medium">Key</th>
                  <th className="px-5 py-3 font-medium">当前版本</th>
                  <th className="px-5 py-3 font-medium">状态</th>
                  <th className="px-5 py-3 font-medium">更新时间</th>
                  <th className="px-5 py-3 font-medium"></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id} className="border-b last:border-0 hover:bg-slate-50/60">
                    <td className="px-5 py-3 font-medium text-slate-900">{item.name}</td>
                    <td className="px-5 py-3 font-mono text-xs text-slate-500">{item.key}</td>
                    <td className="px-5 py-3">
                      {item.currentVersion ? `v${item.currentVersion}` : (
                        <span className="text-slate-400">未发布</span>
                      )}
                    </td>
                    <td className="px-5 py-3">
                      <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-[11px] font-medium text-emerald-700">
                        {item.status}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-xs text-slate-500">{formatDate(item.updatedAt)}</td>
                    <td className="px-5 py-3 text-right">
                      <Link
                        to={`/definitions/${item.key}`}
                        className="text-sm font-medium text-slate-900 underline-offset-4 hover:underline"
                      >
                        打开设计器
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
