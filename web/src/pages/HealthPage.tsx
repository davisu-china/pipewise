import { useCallback, useEffect, useState } from "react";
import {
  Activity,
  Database,
  HardDrive,
  MessageSquare,
  RefreshCw,
  Server,
  type LucideIcon
} from "lucide-react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { getJson, type ApiResponse, type HealthItem } from "../lib/api";

type PingData = {
  service: string;
  status: string;
  time: string;
};

type InfraHealth = {
  postgres: HealthItem;
  redis: HealthItem;
  minio: HealthItem;
  rocketmq: HealthItem;
};

type ServiceCard = {
  key: string;
  name: string;
  icon: LucideIcon;
  item: HealthItem;
};

const badgeStyles: Record<string, string> = {
  UP: "bg-emerald-100 text-emerald-700",
  DOWN: "bg-red-100 text-red-700",
  SKIPPED: "bg-slate-100 text-slate-600",
  CHECKING: "bg-amber-100 text-amber-700"
};

function StatusBadge({ status }: { status: string }) {
  const style = badgeStyles[status] ?? badgeStyles.CHECKING;
  return (
    <span className={`rounded-full px-2.5 py-0.5 text-[11px] font-medium ${style}`}>
      {status}
    </span>
  );
}

function unknownItem(loading: boolean): HealthItem {
  return loading
    ? { status: "CHECKING", detail: "检测中…" }
    : { status: "DOWN", detail: "未返回结果" };
}

export default function HealthPage() {
  const [ping, setPing] = useState<ApiResponse<PingData> | null>(null);
  const [health, setHealth] = useState<ApiResponse<InfraHealth> | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pingResponse, healthResponse] = await Promise.all([
        getJson<PingData>("/api/v1/ping"),
        getJson<InfraHealth>("/api/v1/infra/health")
      ]);
      setPing(pingResponse);
      setHealth(healthResponse);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "请求失败");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const apiItem: HealthItem = ping?.success
    ? {
        status: "UP",
        detail: `${ping.data?.service ?? "pipewise-api"} · ${ping.data?.time ?? ""}`
      }
    : {
        status: loading ? "CHECKING" : "DOWN",
        detail: ping?.error?.message ?? error ?? "API 不可达"
      };

  const cards: ServiceCard[] = [
    { key: "api", name: "API", icon: Server, item: apiItem },
    { key: "postgres", name: "PostgreSQL", icon: Database, item: health?.data?.postgres ?? unknownItem(loading) },
    { key: "redis", name: "Redis", icon: Activity, item: health?.data?.redis ?? unknownItem(loading) },
    { key: "minio", name: "MinIO", icon: HardDrive, item: health?.data?.minio ?? unknownItem(loading) },
    { key: "rocketmq", name: "RocketMQ", icon: MessageSquare, item: health?.data?.rocketmq ?? unknownItem(loading) }
  ];

  const traceId = health?.traceId ?? ping?.traceId ?? null;

  return (
    <main className="mx-auto max-w-6xl px-6 py-8">
      <div className="mb-6 flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-semibold tracking-tight">基础设施连通性</h2>
          <p className="mt-1 text-sm text-slate-500">
            检测 API、PostgreSQL、Redis、MinIO 与 RocketMQ 的认证与读写。
          </p>
        </div>
        <Button onClick={() => void load()} disabled={loading}>
          <RefreshCw size={16} className={loading ? "animate-spin" : undefined} />
          重新检测
        </Button>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {cards.map((card) => {
          const Icon = card.icon;
          return (
            <Card key={card.key}>
              <CardHeader className="flex-row items-center justify-between space-y-0">
                <div className="flex items-center gap-2">
                  <Icon size={16} className="text-slate-500" />
                  <CardTitle>{card.name}</CardTitle>
                </div>
                <StatusBadge status={card.item.status} />
              </CardHeader>
              <CardContent>
                <p className="min-h-[2.5rem] break-all text-xs text-slate-500">
                  {card.item.detail ?? "—"}
                </p>
              </CardContent>
            </Card>
          );
        })}
      </div>

      <p className="mt-6 text-xs text-slate-400">
        traceId: {traceId ?? "—"} · 数据来自 /api/v1/infra/health
      </p>
    </main>
  );
}
