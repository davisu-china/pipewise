import { useState, type ReactNode } from "react";
import { Link } from "react-router-dom";
import { Plus, RefreshCw, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "@/lib/api";
import { errText, useLoad } from "@/lib/hooks";
import type { AdminStats, InstanceInfo } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/page";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/lib/format";

interface OutboxItem {
  id: number;
  instanceId: number;
  type: string;
  status: string;
  attempts: number;
  nextRetryAt: string | null;
  createdAt: string | null;
  deliveredAt: string | null;
}

interface WebhookItem {
  id: number;
  url: string;
  secret: boolean;
  definitionKey: string | null;
  enabled: boolean;
}

interface SinkItem {
  id: number;
  eventType: string;
  payload: unknown;
  signature: string | null;
  receivedAt: string | null;
}

export function Admin() {
  const { data, loading, error, reload } = useLoad(async () => {
    const [stats, outbox, hooks, sink] = await Promise.all([
      api.get<AdminStats>("/admin/stats"),
      api.get<{ items: OutboxItem[] }>("/admin/outbox?limit=30"),
      api.get<{ items: WebhookItem[] }>("/admin/webhooks"),
      api.get<{ items: SinkItem[] }>("/admin/dev-sink?limit=20"),
    ]);
    return { stats, outbox: outbox.items, hooks: hooks.items, sink: sink.items };
  }, []);

  if (error) {
    return (
      <>
        <PageHeader title="运维" />
        <EmptyState>加载失败：{error}</EmptyState>
      </>
    );
  }
  if (loading || !data) {
    return (
      <>
        <PageHeader title="运维" />
        <EmptyState>加载中…</EmptyState>
      </>
    );
  }

  const { stats } = data;

  return (
    <>
      <PageHeader
        title="运维"
        description="状态分布 / 待办积压 / 事件投递 / 回调接收。"
        actions={
          <Button variant="outline" onClick={reload}>
            <RefreshCw /> 刷新
          </Button>
        }
      />

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <StatCard label="实例状态">
          <div className="flex flex-wrap gap-1.5">
            {Object.entries(stats.instancesByStatus || {}).length ? (
              Object.entries(stats.instancesByStatus).map(([k, v]) => (
                <Badge key={k} variant="secondary">
                  {k} · {v}
                </Badge>
              ))
            ) : (
              <span className="text-sm text-muted-foreground">无实例</span>
            )}
          </div>
        </StatCard>
        <StatCard label="在途任务">
          <div className="text-2xl font-semibold">{stats.openTasks}</div>
        </StatCard>
        <StatCard label="事件投递（待投 / 死信）">
          <div className="text-2xl font-semibold">
            {stats.outboxPending} <span className="text-base font-normal text-muted-foreground">/ {stats.outboxDead}</span>
          </div>
        </StatCard>
      </div>

      {!!stats.failedInstances?.length && (
        <Card className="mt-4">
          <CardHeader>
            <CardTitle className="text-base">失败实例</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="w-[80px]">#</TableHead>
                  <TableHead>标题</TableHead>
                  <TableHead>流程</TableHead>
                  <TableHead className="w-[80px]" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {stats.failedInstances.map((i: InstanceInfo) => (
                  <TableRow key={i.id}>
                    <TableCell className="font-mono text-xs">#{i.id}</TableCell>
                    <TableCell>{i.title || "—"}</TableCell>
                    <TableCell>{i.definitionKey}</TableCell>
                    <TableCell>
                      <Button variant="outline" size="sm" asChild>
                        <Link to={`/instances/${i.id}`}>打开</Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">事件 Outbox</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[70px]">ID</TableHead>
                <TableHead>类型</TableHead>
                <TableHead className="w-[120px]">状态</TableHead>
                <TableHead className="w-[90px]">尝试</TableHead>
                <TableHead className="w-[180px]">时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.outbox.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs">{e.id}</TableCell>
                  <TableCell>{e.type}</TableCell>
                  <TableCell>
                    <Badge variant={e.status === "DELIVERED" ? "success" : e.status === "DEAD" ? "destructive" : "warning"}>
                      {e.status}
                    </Badge>
                  </TableCell>
                  <TableCell>{e.attempts}</TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtTime(e.createdAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      <WebhooksCard hooks={data.hooks} onChange={reload} />

      <Card className="mt-4">
        <CardHeader>
          <CardTitle className="text-base">演示回调接收器（最近 20 条）</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[70px]">ID</TableHead>
                <TableHead className="w-[160px]">事件</TableHead>
                <TableHead>载荷</TableHead>
                <TableHead className="w-[180px]">时间</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.sink.map((e) => (
                <TableRow key={e.id}>
                  <TableCell className="font-mono text-xs">{e.id}</TableCell>
                  <TableCell>{e.eventType}</TableCell>
                  <TableCell className="max-w-[520px] truncate font-mono text-xs text-muted-foreground">
                    {JSON.stringify(e.payload).slice(0, 200)}
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtTime(e.receivedAt)}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </>
  );
}

function StatCard({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-xs font-normal text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

function WebhooksCard({ hooks, onChange }: { hooks: WebhookItem[]; onChange: () => void }) {
  const [url, setUrl] = useState("");
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);

  async function add() {
    setBusy(true);
    try {
      await api.post("/admin/webhooks", { url: url.trim(), secret: secret.trim() });
      setUrl("");
      setSecret("");
      toast.success("已添加");
      onChange();
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    try {
      await api.del(`/admin/webhooks/${id}`);
      toast.success("已删除");
      onChange();
    } catch (e) {
      toast.error(errText(e));
    }
  }

  return (
    <Card className="mt-4">
      <CardHeader>
        <CardTitle className="text-base">Webhook 订阅</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>URL</TableHead>
              <TableHead className="w-[150px]">范围</TableHead>
              <TableHead className="w-[100px]">签名</TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {hooks.map((w) => (
              <TableRow key={w.id}>
                <TableCell className="break-all font-mono text-xs">{w.url}</TableCell>
                <TableCell>{w.definitionKey || "（全局）"}</TableCell>
                <TableCell>{w.secret ? "已签名" : "无签名"}</TableCell>
                <TableCell>
                  <Button variant="ghost" size="sm" className="text-destructive" onClick={() => remove(w.id)}>
                    <Trash2 /> 删除
                  </Button>
                </TableCell>
              </TableRow>
            ))}
            {hooks.length === 0 && (
              <TableRow>
                <TableCell colSpan={4} className="text-center text-sm text-muted-foreground">
                  还没有订阅
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>

        <div className="flex flex-wrap items-end gap-2 border-t pt-4">
          <div className="min-w-[260px] flex-1 space-y-1.5">
            <Label htmlFor="hook-url">回调 URL</Label>
            <Input id="hook-url" placeholder="https://example.com/hook" value={url} onChange={(e) => setUrl(e.target.value)} />
          </div>
          <div className="min-w-[220px] flex-1 space-y-1.5">
            <Label htmlFor="hook-secret">密钥（可选）</Label>
            <Input id="hook-secret" placeholder="用于 HMAC 签名" value={secret} onChange={(e) => setSecret(e.target.value)} />
          </div>
          <Button disabled={!url.trim() || busy} onClick={add}>
            <Plus /> 添加
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
