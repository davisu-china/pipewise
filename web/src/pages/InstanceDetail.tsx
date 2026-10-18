import { useState } from "react";
import { Link, useParams } from "react-router-dom";
import { ArrowLeft, Pause, Play, RotateCcw, Square, SlidersHorizontal } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { errText, useLoad } from "@/lib/hooks";
import type { InstanceInfo } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/page";
import { StatusBadge } from "@/components/status";
import { NODE_TYPE_LABEL, fmtTime, fmtValue } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function InstanceDetail() {
  const { id = "" } = useParams();
  const { isAdmin } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.get<InstanceInfo>(`/instances/${id}`), [id]);
  const [force, setForce] = useState<{ taskId: number; verdict: "approve" | "reject" } | null>(null);
  const [setVarOpen, setSetVarOpen] = useState(false);

  async function adminAct(action: string) {
    if (action === "terminate" && !confirm("终止这个实例？在途任务会被回收。")) return;
    try {
      const body = action === "terminate" ? { reason: "管理员终止" } : {};
      await api.post(`/instances/${id}/${action}`, body);
      toast.success("已执行");
      reload();
    } catch (e) {
      toast.error(errText(e));
    }
  }

  async function retry() {
    try {
      await api.post(`/admin/instances/${id}/retry`);
      toast.success("已重试");
      reload();
    } catch (e) {
      toast.error(errText(e));
    }
  }

  if (error) {
    return (
      <>
        <PageHeader title="实例" actions={<BackLink />} />
        <EmptyState>加载失败：{error}</EmptyState>
      </>
    );
  }
  if (loading || !data) {
    return (
      <>
        <PageHeader title="实例" actions={<BackLink />} />
        <EmptyState>加载中…</EmptyState>
      </>
    );
  }

  const timeline = [...(data.timeline || [])].reverse();

  return (
    <>
      <PageHeader
        title={data.title || `实例 #${data.id}`}
        description={`${data.definitionName} · ${data.definitionKey} v${data.version} · ${data.businessKey}`}
        actions={
          <div className="flex items-center gap-2">
            <StatusBadge status={data.status} outcome={data.outcome} />
            <BackLink />
          </div>
        }
      />

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">概要</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[90px_1fr] gap-y-2 text-sm">
              <dt className="text-muted-foreground">发起人</dt>
              <dd>{data.initiatorName}</dd>
              <dt className="text-muted-foreground">创建</dt>
              <dd>{fmtTime(data.createdAt)}</dd>
              <dt className="text-muted-foreground">结束</dt>
              <dd>{fmtTime(data.endedAt)}</dd>
              <dt className="text-muted-foreground">当前节点</dt>
              <dd>
                {data.currentNodes?.length
                  ? data.currentNodes.map((n) => `${n.nodeName}（${n.assignees.join("、") || "—"}）`).join("；")
                  : "—"}
              </dd>
              <dt className="text-muted-foreground">待办</dt>
              <dd>{data.openTasks?.length || 0} 个</dd>
              <dt className="text-muted-foreground">结论</dt>
              <dd>{data.outcome || "—"}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">上下文变量</CardTitle>
          </CardHeader>
          <CardContent>
            {Object.keys(data.variables || {}).length ? (
              <Table>
                <TableBody>
                  {Object.entries(data.variables || {}).map(([k, v]) => (
                    <TableRow key={k}>
                      <TableCell className="w-[160px] font-mono text-xs">{k}</TableCell>
                      <TableCell className="break-all">{fmtValue(v)}</TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">没有变量</p>
            )}
          </CardContent>
        </Card>
      </div>

      {!!data.openTasks?.length && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">在途任务</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>节点</TableHead>
                  <TableHead>处理人</TableHead>
                  <TableHead className="w-[110px]">状态</TableHead>
                  <TableHead className="w-[80px]" />
                  {isAdmin ? <TableHead className="w-[220px]">管理员</TableHead> : null}
                </TableRow>
              </TableHeader>
              <TableBody>
                {data.openTasks.map((t) => (
                  <TableRow key={t.id}>
                    <TableCell>{t.nodeName}</TableCell>
                    <TableCell>{t.assigneeName}</TableCell>
                    <TableCell>
                      <StatusBadge status={t.status} />
                    </TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`/tasks/${t.id}`}>打开</Link>
                      </Button>
                    </TableCell>
                    {isAdmin ? (
                      <TableCell>
                        <div className="flex gap-2">
                          <Button size="sm" variant="secondary" onClick={() => setForce({ taskId: t.id, verdict: "approve" })}>
                            代批通过
                          </Button>
                          <Button size="sm" variant="destructive" onClick={() => setForce({ taskId: t.id, verdict: "reject" })}>
                            代批否决
                          </Button>
                        </div>
                      </TableCell>
                    ) : null}
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">节点执行记录</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>节点</TableHead>
                <TableHead className="w-[110px]">类型</TableHead>
                <TableHead className="w-[110px]">状态</TableHead>
                <TableHead className="w-[80px]">第几次</TableHead>
                <TableHead>结果 / 错误</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {(data.nodeInstances || []).map((n) => (
                <TableRow key={n.id}>
                  <TableCell>{n.nodeName}</TableCell>
                  <TableCell>{NODE_TYPE_LABEL[n.nodeType] || n.nodeType}</TableCell>
                  <TableCell>{n.status}</TableCell>
                  <TableCell>{n.activationSeq}</TableCell>
                  <TableCell className="font-mono text-xs break-all">
                    {n.error || (n.result ? JSON.stringify(n.result) : "—")}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">时间线（审计 + 变量 + 任务）</CardTitle>
        </CardHeader>
        <CardContent>
          <ul className="space-y-3 text-sm">
            {timeline.map((it, idx) => (
              <li key={idx} className="border-l-2 border-border pl-3">
                <div className="flex flex-wrap items-baseline gap-2">
                  <strong className="font-medium">{it.action}</strong>
                  <span className="text-xs text-muted-foreground">{it.actor || ""}</span>
                  <span className="text-xs text-muted-foreground">{fmtTime(it.at)}</span>
                </div>
                {it.detail && Object.keys(it.detail).length ? (
                  <div className="mt-1 break-all font-mono text-xs text-muted-foreground">
                    {JSON.stringify(it.detail).slice(0, 300)}
                  </div>
                ) : null}
              </li>
            ))}
            {timeline.length === 0 && <li className="text-muted-foreground">没有记录</li>}
          </ul>
        </CardContent>
      </Card>

      {isAdmin ? (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">管理员干预</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-wrap gap-2">
            <Button variant="outline" size="sm" onClick={() => adminAct("suspend")}>
              <Pause /> 挂起
            </Button>
            <Button variant="outline" size="sm" onClick={() => adminAct("resume")}>
              <Play /> 恢复
            </Button>
            <Button variant="outline" size="sm" onClick={retry}>
              <RotateCcw /> 重试失败节点
            </Button>
            <Button variant="outline" size="sm" onClick={() => setSetVarOpen(true)}>
              <SlidersHorizontal /> 改变量
            </Button>
            <Button variant="destructive" size="sm" onClick={() => adminAct("terminate")}>
              <Square /> 终止
            </Button>
          </CardContent>
        </Card>
      ) : null}

      <ForceDialog force={force} onClose={() => setForce(null)} onDone={reload} />
      <SetVarDialog open={setVarOpen} onOpenChange={setSetVarOpen} instanceId={id} onDone={reload} />
    </>
  );
}

function BackLink() {
  return (
    <Button variant="outline" asChild>
      <Link to="/instances">
        <ArrowLeft /> 返回
      </Link>
    </Button>
  );
}

function ForceDialog({
  force,
  onClose,
  onDone,
}: {
  force: { taskId: number; verdict: "approve" | "reject" } | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [comment, setComment] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!force) return;
    setBusy(true);
    try {
      await api.post(`/admin/tasks/${force.taskId}/force-complete`, { verdict: force.verdict, comment });
      toast.success("已代批");
      onClose();
      onDone();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!force} onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>管理员代批</DialogTitle>
          <DialogDescription>将以管理员身份直接完成这条任务，操作会写审计。</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label htmlFor="force-comment">操作原因</Label>
          <Input id="force-comment" placeholder="原因（会写审计）" value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button variant={force?.verdict === "reject" ? "destructive" : "default"} disabled={busy} onClick={submit}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SetVarDialog({
  open,
  onOpenChange,
  instanceId,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  instanceId: string;
  onDone: () => void;
}) {
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      parsed = value;
    }
    try {
      await api.post(`/admin/instances/${instanceId}/set-variable`, { name: name.trim(), value: parsed });
      toast.success("已修改");
      onOpenChange(false);
      setName("");
      setValue("");
      onDone();
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
          <DialogTitle>修改变量</DialogTitle>
          <DialogDescription>危险操作：会写审计，按 last-write-wins 覆盖。</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="var-name">变量名</Label>
            <Input id="var-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="变量名" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="var-value">新值</Label>
            <Input id="var-value" value={value} onChange={(e) => setValue(e.target.value)} placeholder="JSON 或字符串" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!name.trim() || busy} onClick={submit}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
