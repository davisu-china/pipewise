export function fmtTime(s?: string | null): string {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("zh-CN", { hour12: false });
}

export function fmtValue(v: unknown): string {
  if (v === null || v === undefined) return "—";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export const NODE_TYPE_LABEL: Record<string, string> = {
  start: "开始",
  end: "结束",
  approval: "审批",
  form: "表单",
  script: "脚本",
  exclusive_gateway: "排他网关",
  parallel_gateway: "并行网关",
};

export const NODE_TYPE_OPTIONS = [
  { value: "approval", label: "审批节点" },
  { value: "form", label: "表单节点" },
  { value: "script", label: "脚本节点" },
  { value: "exclusive_gateway", label: "排他网关" },
  { value: "parallel_gateway", label: "并行网关" },
  { value: "end", label: "结束节点" },
];

export const SIGN_MODE_LABEL: Record<string, string> = {
  any: "或签",
  all: "并签",
  race: "竞签",
  first: "表单填写",
};

export function statusTone(status?: string | null): { label: string; variant: "default" | "secondary" | "destructive" | "success" | "warning" | "outline" } {
  switch (status) {
    case "RUNNING":
      return { label: "运行中", variant: "success" };
    case "COMPLETED":
      return { label: "已完成", variant: "default" };
    case "TERMINATED":
      return { label: "已终止", variant: "destructive" };
    case "FAILED":
      return { label: "失败", variant: "destructive" };
    case "SUSPENDED":
      return { label: "已挂起", variant: "warning" };
    case "CREATED":
      return { label: "待启动", variant: "secondary" };
    case "CLAIMED":
      return { label: "已认领", variant: "warning" };
    case "CANCELLED":
      return { label: "已取消", variant: "secondary" };
    default:
      return { label: status || "—", variant: "outline" };
  }
}
