import { useState } from "react";
import { Link } from "react-router-dom";
import { ArrowRight } from "lucide-react";
import { api } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { useLoad } from "@/lib/hooks";
import type { InstanceInfo } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/page";
import { StatusBadge } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { fmtTime } from "@/lib/format";

const STATUS_OPTIONS = ["", "RUNNING", "COMPLETED", "TERMINATED", "FAILED", "SUSPENDED"];

export function Instances() {
  const { isAdmin } = useAuth();
  const [status, setStatus] = useState("all");
  const { data, loading, error } = useLoad(
    () => api.get<{ items: InstanceInfo[] }>(`/instances${status === "all" ? "" : `?status=${status}`}`),
    [status],
  );

  return (
    <>
      <PageHeader
        title={isAdmin ? "实例（全部）" : "我的实例"}
        description="点开看时间线与当前卡点；管理员可在这里干预。"
        actions={
          <Select value={status} onValueChange={setStatus}>
            <SelectTrigger className="w-[150px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((s) => (
                <SelectItem key={s || "all"} value={s || "all"}>
                  {s || "全部状态"}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />

      {error ? <EmptyState>加载失败：{error}</EmptyState> : null}
      {loading ? <EmptyState>加载中…</EmptyState> : null}

      {data && (
        <Card>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-[70px]">#</TableHead>
                <TableHead>标题</TableHead>
                <TableHead className="w-[180px]">流程</TableHead>
                <TableHead className="w-[170px]">业务单号</TableHead>
                <TableHead className="w-[110px]">发起人</TableHead>
                <TableHead className="w-[110px]">状态</TableHead>
                <TableHead className="w-[170px]">创建时间</TableHead>
                <TableHead className="w-[90px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {data.items.length === 0 && (
                <TableRow>
                  <TableCell colSpan={8}>
                    <div className="py-8 text-center text-sm text-muted-foreground">没有实例</div>
                  </TableCell>
                </TableRow>
              )}
              {data.items.map((i) => (
                <TableRow key={i.id}>
                  <TableCell className="font-mono text-xs">#{i.id}</TableCell>
                  <TableCell className="font-medium">{i.title || "—"}</TableCell>
                  <TableCell>
                    <div>{i.definitionName}</div>
                    <div className="text-xs text-muted-foreground">v{i.version}</div>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{i.businessKey}</TableCell>
                  <TableCell>{i.initiatorName}</TableCell>
                  <TableCell>
                    <StatusBadge status={i.status} outcome={i.outcome} />
                  </TableCell>
                  <TableCell className="text-xs text-muted-foreground">{fmtTime(i.createdAt)}</TableCell>
                  <TableCell>
                    <Button variant="outline" size="sm" asChild>
                      <Link to={`/instances/${i.id}`}>
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
