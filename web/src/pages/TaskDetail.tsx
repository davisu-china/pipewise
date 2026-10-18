import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Check, UserPlus, Users, X } from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { errText, useLoad } from "@/lib/hooks";
import type { TaskFormResponse, UserInfo } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/page";
import { StatusBadge } from "@/components/status";
import { FormFields } from "@/components/form-fields";
import { SIGN_MODE_LABEL } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function TaskDetail() {
  const { id = "" } = useParams();
  const nav = useNavigate();
  const { me } = useAuth();
  const { data, loading, error } = useLoad(() => api.get<TaskFormResponse>(`/tasks/${id}/form`), [id]);
  const { data: usersData } = useLoad(() => api.get<{ items: UserInfo[] }>("/users"));

  const [values, setValues] = useState<Record<string, unknown>>({});
  const [comment, setComment] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [delegateOpen, setDelegateOpen] = useState(false);
  const [signOpen, setSignOpen] = useState(false);

  useEffect(() => {
    if (!data) return;
    const init: Record<string, unknown> = {};
    for (const f of data.form?.fields || []) if (f.name) init[f.name] = f.value;
    setValues(init);
  }, [data]);

  async function submit(verdict: "approve" | "reject" | "submit") {
    if (!data) return;
    setBusy(true);
    setErrors({});
    const editable: Record<string, unknown> = {};
    for (const f of data.form?.fields || []) {
      if (f.access === "editable" && f.name) editable[f.name] = values[f.name];
    }
    try {
      if (data.nodeType === "approval" && !data.form) {
        await api.post(`/tasks/${id}/complete`, { verdict, comment });
      } else if (data.nodeType === "approval") {
        await api.post(`/tasks/${id}/submit-form`, { verdict, comment, data: editable });
      } else {
        await api.post(`/tasks/${id}/submit-form`, { comment, data: editable });
      }
      toast.success("已提交");
      nav("/tasks");
    } catch (e) {
      if (e instanceof ApiError && e.code === "FORM_VALIDATION_FAILED") {
        const list = (e.details.errors as Array<{ field: string; message: string }>) || [];
        const map: Record<string, string> = {};
        for (const x of list) map[x.field] = x.message;
        setErrors(map);
        toast.error(list.map((x) => `${x.field}：${x.message}`).join("；") || e.message);
      } else {
        toast.error(errText(e));
      }
    } finally {
      setBusy(false);
    }
  }

  if (error) {
    return (
      <>
        <PageHeader title="任务" actions={<BackLink />} />
        <EmptyState>加载失败：{error}</EmptyState>
      </>
    );
  }
  if (loading || !data) {
    return (
      <>
        <PageHeader title="任务" actions={<BackLink />} />
        <EmptyState>加载中…</EmptyState>
      </>
    );
  }

  const done = data.task.status === "COMPLETED" || data.task.status === "CANCELLED";
  const isApproval = data.nodeType === "approval";
  const others = (usersData?.items || []).filter((u) => u.id !== me?.id);

  return (
    <>
      <PageHeader
        title={data.nodeName || `任务 ${id}`}
        description={`${data.instance.title || ""} · ${data.instance.businessKey} · ${SIGN_MODE_LABEL[data.signMode || ""] || data.signMode || "—"}`}
        actions={<BackLink />}
      />

      <Card>
        <CardHeader className="flex-row items-center justify-between space-y-0">
          <CardTitle className="text-base">表单</CardTitle>
          <div className="flex items-center gap-2">
            <StatusBadge status={data.task.status} />
            {done ? <span className="text-xs text-muted-foreground">任务已结束</span> : null}
          </div>
        </CardHeader>
        <CardContent className="space-y-5">
          {data.form ? (
            <FormFields fields={data.form.fields} values={values} onChange={setValues} errors={errors} />
          ) : (
            <p className="text-sm text-muted-foreground">这个节点没有绑定表单，直接给出审批结论即可。</p>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="comment">审批意见</Label>
            <Textarea id="comment" placeholder="审批意见（可选）" value={comment} onChange={(e) => setComment(e.target.value)} />
          </div>
        </CardContent>
        <CardFooter className="flex flex-wrap items-center gap-2 border-t pt-4">
          {done ? null : isApproval ? (
            <>
              <Button disabled={busy} onClick={() => submit("approve")}>
                <Check /> 同意
              </Button>
              <Button variant="destructive" disabled={busy} onClick={() => submit("reject")}>
                <X /> 否决
              </Button>
            </>
          ) : (
            <Button disabled={busy} onClick={() => submit("submit")}>
              <Check /> {data.task.kind === "resubmit" ? "重新提交" : "提交"}
            </Button>
          )}
          <span className="flex-1" />
          <Button variant="outline" size="sm" disabled={done} onClick={() => setDelegateOpen(true)}>
            <Users /> 转交
          </Button>
          <Button variant="outline" size="sm" disabled={done} onClick={() => setSignOpen(true)}>
            <UserPlus /> 加签
          </Button>
        </CardFooter>
      </Card>

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">所属实例</CardTitle>
        </CardHeader>
        <CardContent className="flex items-center gap-2 text-sm">
          <Link className="text-primary underline-offset-4 hover:underline" to={`/instances/${data.instance.id}`}>
            #{data.instance.id} {data.instance.title || ""}
          </Link>
          <StatusBadge status={data.instance.status} />
        </CardContent>
      </Card>

      <DelegateDialog
        open={delegateOpen}
        onOpenChange={setDelegateOpen}
        taskId={id}
        users={others}
        onDone={() => nav("/tasks")}
      />
      <AddSignDialog open={signOpen} onOpenChange={setSignOpen} taskId={id} users={others} />
    </>
  );
}

function BackLink() {
  return (
    <Button variant="outline" asChild>
      <Link to="/tasks">
        <ArrowLeft /> 返回待办
      </Link>
    </Button>
  );
}

function DelegateDialog({
  open,
  onOpenChange,
  taskId,
  users,
  onDone,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  taskId: string;
  users: UserInfo[];
  onDone: () => void;
}) {
  const [target, setTarget] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post(`/tasks/${taskId}/delegate`, { to: target });
      toast.success("已转交");
      onOpenChange(false);
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
          <DialogTitle>转交任务</DialogTitle>
          <DialogDescription>转交后，这条任务会从你的待办移到对方名下。</DialogDescription>
        </DialogHeader>
        <div className="space-y-1.5">
          <Label>转交给</Label>
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger>
              <SelectValue placeholder="选择用户" />
            </SelectTrigger>
            <SelectContent>
              {users.map((u) => (
                <SelectItem key={u.id} value={u.id}>
                  {u.name}（{u.id}）
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!target || busy} onClick={submit}>
            转交
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AddSignDialog({
  open,
  onOpenChange,
  taskId,
  users,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  taskId: string;
  users: UserInfo[];
}) {
  const [chosen, setChosen] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);

  function toggle(id: string, checked: boolean) {
    setChosen((prev) => (checked ? [...prev, id] : prev.filter((x) => x !== id)));
  }

  async function submit() {
    setBusy(true);
    try {
      const r = await api.post<{ added: string[] }>(`/tasks/${taskId}/add-sign`, { users: chosen });
      toast.success(`已加签 ${r.added.length} 人`);
      onOpenChange(false);
      setChosen([]);
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
          <DialogTitle>加签</DialogTitle>
          <DialogDescription>加签产生的任务纳入本节点同一裁决集合。</DialogDescription>
        </DialogHeader>
        <div className="flex max-h-64 flex-wrap gap-x-5 gap-y-2 overflow-y-auto">
          {users.map((u) => (
            <label key={u.id} className="flex items-center gap-2 text-sm">
              <Checkbox checked={chosen.includes(u.id)} onCheckedChange={(v) => toggle(u.id, v === true)} />
              {u.name}（{u.id}）
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button disabled={!chosen.length || busy} onClick={submit}>
            确定
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
