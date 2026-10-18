import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Plus, Play, Rocket, Settings2, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLoad, errText } from "@/lib/hooks";
import type { Definition, Issue, VersionInfo } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/page";
import { IssuesDialog } from "@/components/issues-dialog";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function Definitions() {
  const { isAdmin, isDesigner } = useAuth();
  const nav = useNavigate();
  const { data, loading, error, reload } = useLoad(() => api.get<{ items: Definition[] }>("/definitions"));
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [versions, setVersions] = useState<{ key: string; items: VersionInfo[] } | null>(null);

  async function publish(key: string) {
    try {
      const v = await api.post<VersionInfo>(`/definitions/${key}/publish`);
      toast.success(`已发布 v${v.version}`);
      reload();
    } catch (e) {
      if (e instanceof ApiError && e.code === "VALIDATION_FAILED") {
        setIssues((e.details.issues as Issue[]) || []);
        setIssuesOpen(true);
      } else {
        toast.error(errText(e));
      }
    }
  }

  async function retire(key: string) {
    if (!confirm(`下线 ${key}？已在跑的实例不受影响，但不能再发起新实例。`)) return;
    try {
      await api.post(`/definitions/${key}/retire`);
      toast.success("已下线");
      reload();
    } catch (e) {
      toast.error(errText(e));
    }
  }

  async function showVersions(key: string) {
    try {
      const out = await api.get<{ items: VersionInfo[] }>(`/definitions/${key}/versions`);
      setVersions({ key, items: out.items });
    } catch (e) {
      toast.error(errText(e));
    }
  }

  return (
    <>
      <PageHeader
        title="流程定义"
        description="定义 → 发布版本 → 创建实例。已发布版本不可变，实例永远钉在创建时的版本上。"
        actions={
          isDesigner ? (
            <Button onClick={() => setCreateOpen(true)}>
              <Plus /> 新建流程
            </Button>
          ) : null
        }
      />

      {error ? <EmptyState>加载失败：{error}</EmptyState> : null}
      {loading ? <EmptyState>加载中…</EmptyState> : null}

      {data && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[220px]">KEY</TableHead>
                <TableHead>名称</TableHead>
                <TableHead className="w-[100px]">状态</TableHead>
                <TableHead className="w-[110px]">当前版本</TableHead>
                <TableHead className="w-[420px]">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={5}>
                    <EmptyState>还没有流程定义</EmptyState>
                  </TableCell>
                </TableRow>
              )}
              {data.items.map((d) => (
                <TableRow key={d.id}>
                  <TableCell className="font-mono text-xs">{d.key}</TableCell>
                  <TableCell>
                    <div className="font-medium">{d.name}</div>
                    {d.description ? <div className="text-xs text-muted-foreground">{d.description}</div> : null}
                  </TableCell>
                  <TableCell>
                    <Badge variant={d.status === "active" ? "success" : "secondary"}>{d.status === "active" ? "启用" : d.status}</Badge>
                  </TableCell>
                  <TableCell>
                    <button className="text-sm underline-offset-4 hover:underline" onClick={() => showVersions(d.key)}>
                      {d.currentVersion ? `v${d.currentVersion}` : "未发布"}
                    </button>
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap items-center gap-2">
                      {isDesigner ? (
                        <Button variant="outline" size="sm" asChild>
                          <Link to={`/designer/${d.key}`}>
                            <Settings2 /> 设计
                          </Link>
                        </Button>
                      ) : null}
                      {isAdmin ? (
                        <Button size="sm" onClick={() => publish(d.key)}>
                          <Rocket /> {d.currentVersion ? "发布草稿" : "发布"}
                        </Button>
                      ) : null}
                      {isAdmin && d.status === "active" ? (
                        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => retire(d.key)}>
                          <Trash2 /> 下线
                        </Button>
                      ) : null}
                      <Button variant="secondary" size="sm" asChild>
                        <Link to={`/start/${d.key}`}>
                          <Play /> 发起
                        </Link>
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}

      <div className="mt-6 rounded-xl border bg-card p-5 text-sm text-muted-foreground">
        <div className="font-medium text-foreground">版本规则</div>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          <li>草稿可随意编辑；<b>提交</b>生成不可变版本，<b>管理员发布</b>后新实例默认使用它。</li>
          <li>已跑实例不受新版本影响；下线只拦截新实例（PRD §6.2）。</li>
          <li>设计器里的「试跑」会在一个会回滚的事务里真跑一遍，用来验证分支与脚本。</li>
        </ul>
      </div>

      <CreateDefinitionDialog open={createOpen} onOpenChange={setCreateOpen} onCreated={(key) => nav(`/designer/${key}`)} />
      <IssuesDialog open={issuesOpen} onOpenChange={setIssuesOpen} issues={issues} />

      <Dialog open={!!versions} onOpenChange={(v) => !v && setVersions(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>版本历史 · {versions?.key}</DialogTitle>
          </DialogHeader>
          <div className="space-y-2 text-sm">
            {versions?.items.length === 0 && <p className="text-muted-foreground">还没有版本。</p>}
            {versions?.items.map((v) => (
              <div key={v.id} className="flex items-center justify-between rounded-md border p-2.5">
                <span className="font-medium">v{v.version}</span>
                <StatusBadge status={v.status === "PUBLISHED" ? "COMPLETED" : v.status === "SUBMITTED" ? "SUSPENDED" : "CREATED"} />
                <span className="text-xs text-muted-foreground">{v.publishedAt ? `发布于 ${new Date(v.publishedAt).toLocaleString("zh-CN", { hour12: false })}` : "未发布"}</span>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}

function CreateDefinitionDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: (key: string) => void }) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      const d = await api.post<Definition>("/definitions", { key: key.trim(), name: name.trim() });
      toast.success("已创建");
      onOpenChange(false);
      onCreated(d.key);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>新建流程</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="def-key">Key（跨版本不变的稳定标识）</Label>
            <Input id="def-key" placeholder="expense_approval（小写字母/数字/下划线）" value={key} onChange={(e) => setKey(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="def-name">名称</Label>
            <Input id="def-name" placeholder="费用报销审批" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={submit} disabled={busy || !key.trim() || !name.trim()}>
            创建
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
