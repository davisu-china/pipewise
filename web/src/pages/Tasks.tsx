import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight, CheckCircle2 } from "lucide-react";
import { api } from "@/lib/api";
import { useLoad } from "@/lib/hooks";
import type { TaskInfo } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/page";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/lib/format";

export function Tasks() {
  const [tab, setTab] = useState<"pending" | "done">("pending");
  const { data, loading, error } = useLoad(
    () => api.get<{ items: TaskInfo[] }>(`/tasks?assignee=me&status=${tab}`),
    [tab],
  );

  return (
    <>
      <PageHeader
        title="我的待办"
        description="同意 / 否决 / 转交 / 加签都在任务详情里。"
        actions={
          <Tabs value={tab} onValueChange={(v) => setTab(v as "pending" | "done")}>
            <TabsList>
              <TabsTrigger value="pending">待办</TabsTrigger>
              <TabsTrigger value="done">已办</TabsTrigger>
            </TabsList>
          </Tabs>
        }
      />

      {error ? <EmptyState>加载失败：{error}</EmptyState> : null}
      {loading ? <EmptyState>加载中…</EmptyState> : null}

      {data && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>标题</TableHead>
                <TableHead className="w-[180px]">节点</TableHead>
                <TableHead className="w-[180px]">业务单号</TableHead>
                <TableHead className="w-[110px]">状态</TableHead>
                <TableHead className="w-[170px]">时间</TableHead>
                <TableHead className="w-[90px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={6}>
                    <div className="flex flex-col items-center gap-2 py-8 text-sm text-muted-foreground">
                      <CheckCircle2 className="h-6 w-6" />
                      {tab === "pending" ? "没有待办" : "还没有处理过的任务"}
                    </div>
                  </TableCell>
                </TableRow>
              )}
              {data.items.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-medium">{t.title || t.definitionKey || "—"}</TableCell>
                  <TableCell>
                    <div>{t.nodeName}</div>
                    <div className="text-xs text-muted-foreground">{t.kind === "resubmit" ? "重提单" : t.kind}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{t.businessKey || "—"}</TableCell>
                  <TableCell>
                    <StatusBadge status={t.status} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtTime(t.createdAt)}</TableCell>
                  <TableCell>
                    <Button variant="outline" size="sm" asChild>
                      <Link to={`/tasks/${t.id}`}>
                        打开 <ArrowRight />
                      </Link>
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </>
  );
}
