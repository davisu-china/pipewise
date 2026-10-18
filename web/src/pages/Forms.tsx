import { useState } from "react";
import { Plus, Rocket, Settings2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { errText, useLoad } from "@/lib/hooks";
import type { FormAsset, FormSchema } from "@/lib/types";
import { EmptyState, PageHeader } from "@/components/page";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function Forms() {
  const { isAdmin, isDesigner } = useAuth();
  const { data, loading, error, reload } = useLoad(() => api.get<{ items: FormAsset[] }>("/forms"));
  const [editing, setEditing] = useState<FormAsset | null>(null);
  const [creating, setCreating] = useState(false);

  async function publish(f: FormAsset) {
    if (!confirm(`发布表单 ${f.key} 的草稿？已绑定旧版本的流程不受影响。`)) return;
    try {
      const r = await api.post<{ version: number }>(`/forms/${f.key}/publish`);
      toast.success(`已发布 v${r.version}`);
      reload();
    } catch (e) {
      toast.error(errText(e));
    }
  }

  return (
    <>
      <PageHeader
        title="表单"
        description="表单是独立可复用资产；流程节点通过 formRef 绑定它，并配置「节点 × 字段」权限。"
        actions={
          isDesigner ? (
            <Button onClick={() => setCreating(true)}>
              <Plus /> 新建表单
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
                <TableHead className="w-[100px]">已发布</TableHead>
                <TableHead className="w-[100px]">字段数</TableHead>
                <TableHead className="w-[220px]">操作</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.map((f) => (
                <TableRow key={f.id}>
                  <TableCell className="font-mono text-xs">{f.key}</TableCell>
                  <TableCell className="font-medium">{f.name}</TableCell>
                  <TableCell>
                    {f.published ? <Badge variant="success">v{f.published.version}</Badge> : <Badge variant="warning">未发布</Badge>}
                  </TableCell>
                  <TableCell>{(f.published?.schema.fields || []).length}</TableCell>
                  <TableCell>
                    <div className="flex gap-2">
                      {isDesigner ? (
                        <Button variant="outline" size="sm" onClick={() => setEditing(f)}>
                          <Settings2 /> 编辑
                        </Button>
                      ) : null}
                      {isAdmin ? (
                        <Button size="sm" onClick={() => publish(f)}>
                          <Rocket /> 发布
                        </Button>
                      ) : null}
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
      <FormEditor asset={editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); reload(); }} />
      <CreateFormDialog open={creating} onOpenChange={setCreating} onCreated={() => { setCreating(false); reload(); }} />
    </>
  );
}

function FormEditor({ asset, onClose, onSaved }: { asset: FormAsset | null; onClose: () => void; onSaved: () => void }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [loadedFor, setLoadedFor] = useState<number | null>(null);

  // 每次换表单时重置编辑器内容
  if (asset && loadedFor !== asset.id) {
    setLoadedFor(asset.id);
    setText(JSON.stringify(asset.draftSchema, null, 2));
  }

  async function save() {
    if (!asset) return;
    let schema: FormSchema;
    try {
      schema = JSON.parse(text) as FormSchema;
    } catch (e) {
      toast.error("JSON 解析失败：" + (e instanceof Error ? e.message : "格式不对"));
      return;
    }
    setBusy(true);
    try {
      await api.put(`/forms/${asset.key}/draft`, { schema, rev: asset.draftRev });
      toast.success("表单草稿已保存");
      onSaved();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={!!asset} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>表单 {asset?.key}</DialogTitle>
          <DialogDescription>MVP 用 JSON 编辑字段；可视化拖拽设计器见技术方案 §11。</DialogDescription>
        </DialogHeader>
        <Textarea className="min-h-[420px] font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            取消
          </Button>
          <Button onClick={save} disabled={busy}>
            保存草稿
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateFormDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (v: boolean) => void; onCreated: () => void }) {
  const [key, setKey] = useState("");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit() {
    setBusy(true);
    try {
      await api.post("/forms", { key: key.trim(), name: name.trim(), schema: { key: key.trim(), name: name.trim(), fields: [] } });
      toast.success("已创建");
      onCreated();
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
          <DialogTitle>新建表单</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="form-key">Key</Label>
            <Input id="form-key" value={key} onChange={(e) => setKey(e.target.value)} placeholder="expense_form" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="form-name">名称</Label>
            <Input id="form-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="费用报销单" />
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
