import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { Link, useParams } from "react-router-dom";
import {
  ArrowLeft,
  Braces,
  CheckCircle2,
  FlaskConical,
  Link2,
  Plus,
  Rocket,
  Save,
  Trash2,
} from "lucide-react";
import { toast } from "sonner";
import { api, ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { errText, useLoad } from "@/lib/hooks";
import type { Definition, FormSchema, Issue, VersionInfo } from "@/lib/types";
import { PageHeader, EmptyState } from "@/components/page";
import { IssuesDialog } from "@/components/issues-dialog";
import { NODE_TYPE_LABEL, NODE_TYPE_OPTIONS } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";

// ---------------------------------------------------------------- 类型

interface Pos {
  x: number;
  y: number;
}

interface Assignee {
  type: string;
  id?: string;
  code?: string;
  level?: number;
  of?: string;
  expr?: string;
}

interface FieldPerm {
  access?: string;
  required?: boolean;
}

interface DNode {
  id: string;
  type: string;
  name?: string;
  position?: Pos;
  assignee?: Assignee;
  signMode?: string;
  rejectStrategy?: string;
  formRef?: string;
  fieldPermissions?: Record<string, FieldPerm>;
  script?: string;
  retries?: number;
  onErrorEdge?: string;
  gatewayDirection?: string;
}

interface DEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
}

interface DVar {
  name: string;
  type?: string;
  required?: boolean;
  default?: unknown;
}

interface DSnap {
  key?: string;
  name?: string;
  startableBy?: string[];
  variables?: DVar[];
  nodes: DNode[];
  edges: DEdge[];
}

type Sel = { kind: "node"; id: string } | { kind: "edge"; id: string } | null;
type Updater = (fn: (s: DSnap) => void) => void;

const NONE = "__none__";
const DEFAULT_ACCESS = "__default__";

// ---------------------------------------------------------------- 页面

export function Designer() {
  const { key = "" } = useParams();
  const { isAdmin, isDesigner } = useAuth();
  const { data, loading, error, reload } = useLoad(async () => {
    const def = await api.get<Definition>(`/definitions/${key}`);
    const schemas = await api.get<{ items: Record<string, FormSchema> }>(`/definitions/${key}/form-schemas`);
    return { def, schemas: schemas.items };
  }, [key]);

  const [snap, setSnap] = useState<DSnap | null>(null);
  const [rev, setRev] = useState(0);
  const [selected, setSelected] = useState<Sel>(null);
  const [connectFrom, setConnectFrom] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [issuesOpen, setIssuesOpen] = useState(false);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [dryOpen, setDryOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!data) return;
    const next = JSON.parse(JSON.stringify(data.def.draft || { nodes: [], edges: [] })) as DSnap;
    layoutMissing(next);
    setSnap(next);
    setRev(data.def.draftRev);
    setSelected(null);
  }, [data]);

  const update = useCallback<Updater>((fn) => {
    setSnap((prev) => {
      if (!prev) return prev;
      const next = JSON.parse(JSON.stringify(prev)) as DSnap;
      fn(next);
      return next;
    });
  }, []);

  async function saveDraft(silent = false): Promise<boolean> {
    if (!snap) return false;
    setBusy(true);
    try {
      const r = await api.put<{ rev: number; issues: Issue[] }>(`/definitions/${key}/draft`, { snapshot: snap, rev });
      setRev(r.rev);
      if (!silent) toast.success("草稿已保存");
      const errs = (r.issues || []).filter((i) => i.level === "error");
      if (errs.length) {
        setIssues(r.issues);
        setIssuesOpen(true);
      }
      return true;
    } catch (e) {
      toast.error(errText(e));
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function validate() {
    if (!snap) return;
    try {
      const r = await api.post<{ issues: Issue[] }>(`/definitions/${key}/validate`, { snapshot: snap });
      setIssues(r.issues || []);
      setIssuesOpen(true);
    } catch (e) {
      toast.error(errText(e));
    }
  }

  async function submitDraft() {
    if (!confirm("提交发布？会生成一个不可变版本，等管理员发布。")) return;
    if (!(await saveDraft(true))) return;
    try {
      const v = await api.post<VersionInfo>(`/definitions/${key}/submit`);
      toast.success(`已提交 v${v.version}，等管理员发布`);
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

  async function publish() {
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

  if (error) {
    return (
      <>
        <PageHeader title="设计器" actions={<BackLink />} />
        <EmptyState>加载失败：{error}</EmptyState>
      </>
    );
  }
  if (loading || !data || !snap) {
    return (
      <>
        <PageHeader title="设计器" actions={<BackLink />} />
        <EmptyState>加载中…</EmptyState>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title={data.def.name || key}
        description={`${key} · 草稿 rev ${rev} · 当前版本 ${data.def.currentVersion ? `v${data.def.currentVersion}` : "未发布"}`}
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" asChild>
              <Link to="/definitions">
                <ArrowLeft /> 返回列表
              </Link>
            </Button>
          </div>
        }
      />

      <DesignerToolbar
        connectFrom={connectFrom}
        busy={busy}
        canSave={isDesigner}
        canPublish={isAdmin}
        onAdd={(type) => addNode(snap, update, type, setSelected)}
        onToggleConnect={() => setConnectFrom((v) => (v === null ? "" : null))}
        onValidate={validate}
        onDryRun={() => setDryOpen(true)}
        onJson={() => setJsonOpen(true)}
        onSave={() => saveDraft()}
        onSubmit={submitDraft}
        onPublish={publish}
      />

      <div className="mt-4 grid gap-4 xl:grid-cols-[minmax(0,1fr)_360px]">
        <Canvas
          snap={snap}
          selected={selected}
          connectFrom={connectFrom}
          onSelect={setSelected}
          onUpdate={update}
          onConnect={(from, to) => {
            addEdge(update, from, to);
            setConnectFrom(null);
          }}
          onConnectStep={(id) => setConnectFrom(id)}
          onConnectInfo={() => toast("已选起点，再点终点")}
          onConnectCancel={() => setConnectFrom(null)}
        />
        <Panel
          snap={snap}
          selected={selected}
          schemas={data.schemas}
          edges={snap.edges}
          update={update}
          onDeleteNode={(id) => {
            update((s) => {
              s.nodes = s.nodes.filter((n) => n.id !== id);
              s.edges = s.edges.filter((e) => e.from !== id && e.to !== id);
            });
            setSelected(null);
          }}
          onDeleteEdge={(id) => {
            update((s) => {
              s.edges = s.edges.filter((e) => e.id !== id);
            });
            setSelected(null);
          }}
        />
      </div>

      <IssuesDialog open={issuesOpen} onOpenChange={setIssuesOpen} issues={issues} />
      <JsonDialog
        open={jsonOpen}
        onOpenChange={setJsonOpen}
        snap={snap}
        onApply={(next) => {
          layoutMissing(next);
          setSnap(next);
          setSelected(null);
          toast.success("已应用到草稿（记得保存）");
        }}
      />
      <DryRunDialog open={dryOpen} onOpenChange={setDryOpen} definitionKey={key} snap={snap} />
    </>
  );
}

function BackLink() {
  return (
    <Button variant="outline" asChild>
      <Link to="/definitions">
        <ArrowLeft /> 返回列表
      </Link>
    </Button>
  );
}

// ---------------------------------------------------------------- 工具栏

function DesignerToolbar({
  connectFrom,
  busy,
  canSave,
  canPublish,
  onAdd,
  onToggleConnect,
  onValidate,
  onDryRun,
  onJson,
  onSave,
  onSubmit,
  onPublish,
}: {
  connectFrom: string | null;
  busy: boolean;
  canSave: boolean;
  canPublish: boolean;
  onAdd: (type: string) => void;
  onToggleConnect: () => void;
  onValidate: () => void;
  onDryRun: () => void;
  onJson: () => void;
  onSave: () => void;
  onSubmit: () => void;
  onPublish: () => void;
}) {
  const [type, setType] = useState("approval");

  return (
    <Card className="flex flex-wrap items-center gap-2 p-3">
      <span className="pl-1 text-sm text-muted-foreground">添加：</span>
      <Select value={type} onValueChange={setType}>
        <SelectTrigger className="w-[150px]">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {NODE_TYPE_OPTIONS.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" variant="outline" onClick={() => onAdd(type)}>
        <Plus /> 节点
      </Button>
      <Button size="sm" variant={connectFrom !== null ? "default" : "outline"} onClick={onToggleConnect}>
        <Link2 /> {connectFrom !== null ? "连线中：点起点→终点（取消）" : "连线"}
      </Button>

      <span className="flex-1" />

      <Button size="sm" variant="outline" onClick={onValidate}>
        <CheckCircle2 /> 校验
      </Button>
      <Button size="sm" variant="outline" onClick={onDryRun}>
        <FlaskConical /> 试跑
      </Button>
      <Button size="sm" variant="outline" onClick={onJson}>
        <Braces /> JSON
      </Button>
      {canSave ? (
        <Button size="sm" onClick={onSave} disabled={busy}>
          <Save /> 保存草稿
        </Button>
      ) : null}
      {canSave ? (
        <Button size="sm" variant="secondary" onClick={onSubmit} disabled={busy}>
          提交发布
        </Button>
      ) : null}
      {canPublish ? (
        <Button size="sm" onClick={onPublish}>
          <Rocket /> 发布
        </Button>
      ) : null}
    </Card>
  );
}

function addNode(snap: DSnap, update: Updater, type: string, select: (s: Sel) => void) {
  let i = 1;
  while (snap.nodes.some((n) => n.id === `${type}_${i}`)) i++;
  const id = `${type}_${i}`;
  const node: DNode = { id, type, name: `${NODE_TYPE_LABEL[type] || type}${i}`, position: { x: 320, y: 380 } };
  if (type === "approval") Object.assign(node, { assignee: { type: "managerOf", level: 1 }, signMode: "any", rejectStrategy: "to_start" });
  if (type === "form") node.assignee = { type: "role", code: "hr" };
  if (type === "script") node.script = "def run(ctx, local, env, logger, now):\n    return {}\n";
  if (type === "exclusive_gateway") node.name = "条件分支";
  if (type === "parallel_gateway") node.gatewayDirection = "fork";
  update((s) => {
    s.nodes.push(node);
  });
  select({ kind: "node", id });
}

function addEdge(update: Updater, from: string, to: string) {
  update((s) => {
    let i = 1;
    while (s.edges.some((e) => e.id === `e${i}`)) i++;
    s.edges.push({ id: `e${i}`, from, to });
  });
}

function layoutMissing(snap: DSnap) {
  const level: Record<string, number> = {};
  const start = (snap.nodes || []).find((n) => n.type === "start");
  const out: Record<string, string[]> = {};
  for (const e of snap.edges || []) (out[e.from] = out[e.from] || []).push(e.to);
  if (start) {
    const q: Array<[string, number]> = [[start.id, 0]];
    level[start.id] = 0;
    while (q.length) {
      const [id, lv] = q.shift()!;
      for (const to of out[id] || []) {
        if (level[to] === undefined) {
          level[to] = lv + 1;
          q.push([to, lv + 1]);
        }
      }
    }
  }
  const per: Record<number, number> = {};
  for (const n of snap.nodes || []) {
    const lv = level[n.id] ?? 0;
    per[lv] = (per[lv] || 0) + 1;
    if (!n.position) n.position = { x: 60 + lv * 190, y: 60 + (per[lv] - 1) * 100 };
  }
}

// ---------------------------------------------------------------- 画布

function Canvas({
  snap,
  selected,
  connectFrom,
  onSelect,
  onUpdate,
  onConnect,
  onConnectStep,
  onConnectInfo,
  onConnectCancel,
}: {
  snap: DSnap;
  selected: Sel;
  connectFrom: string | null;
  onSelect: (s: Sel) => void;
  onUpdate: Updater;
  onConnect: (from: string, to: string) => void;
  onConnectStep: (id: string) => void;
  onConnectInfo: () => void;
  onConnectCancel: () => void;
}) {
  const svgRef = useRef<SVGSVGElement>(null);
  const drag = useRef<{ id: string; start: Pos; orig: Pos; moved: boolean } | null>(null);
  const justDragged = useRef(false);

  const nodes = snap.nodes || [];
  const edges = snap.edges || [];
  const W = Math.max(1100, ...nodes.map((n) => (n.position?.x || 0) + 180)) + 60;
  const H = Math.max(700, ...nodes.map((n) => (n.position?.y || 0) + 90)) + 60;

  function point(e: { clientX: number; clientY: number }): Pos {
    const svg = svgRef.current;
    if (!svg) return { x: e.clientX, y: e.clientY };
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    const m = svg.getScreenCTM();
    if (!m) return { x: e.clientX, y: e.clientY };
    const p = pt.matrixTransform(m.inverse());
    return { x: p.x, y: p.y };
  }

  function nodeDown(e: ReactPointerEvent<SVGGElement>, node: DNode) {
    if (connectFrom !== null) return;
    e.preventDefault();
    svgRef.current?.setPointerCapture(e.pointerId);
    drag.current = { id: node.id, start: point(e), orig: node.position || { x: 0, y: 0 }, moved: false };
    justDragged.current = false;
  }

  function svgMove(e: ReactPointerEvent<SVGSVGElement>) {
    const d = drag.current;
    if (!d) return;
    const p = point(e);
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) {
      d.moved = true;
      justDragged.current = true;
    }
    if (!d.moved) return;
    const nx = Math.round((d.orig.x + dx) / 10) * 10;
    const ny = Math.round((d.orig.y + dy) / 10) * 10;
    onUpdate((s) => {
      const n = s.nodes.find((x) => x.id === d.id);
      if (n) n.position = { x: nx, y: ny };
    });
  }

  function svgUp() {
    const d = drag.current;
    drag.current = null;
    if (d?.moved) onSelect({ kind: "node", id: d.id });
  }

  function nodeClick(e: ReactMouseEvent<SVGGElement>, node: DNode) {
    e.stopPropagation();
    if (connectFrom !== null) {
      if (connectFrom === "") {
        onConnectStep(node.id);
        onConnectInfo();
      } else if (connectFrom === node.id) {
        onConnectCancel();
      } else {
        onConnect(connectFrom, node.id);
      }
      return;
    }
    onSelect({ kind: "node", id: node.id });
  }

  return (
    <div className="overflow-auto rounded-xl border bg-card p-2" style={{ minHeight: 560 }}>
      <svg
        ref={svgRef}
        width={W}
        height={H}
        className="select-none"
        onPointerMove={svgMove}
        onPointerUp={svgUp}
        onClick={() => {
          if (justDragged.current || drag.current) {
            justDragged.current = false;
            return;
          }
          onSelect(null);
        }}
      >
        <defs>
          <marker id="pw-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z" fill="#94a3b8" />
          </marker>
        </defs>

        {edges.map((e) => {
          const a = nodes.find((n) => n.id === e.from);
          const b = nodes.find((n) => n.id === e.to);
          if (!a || !b) return null;
          const d = edgePath(a, b);
          const isSel = selected?.kind === "edge" && selected.id === e.id;
          return (
            <g key={e.id}>
              <path
                d={d}
                fill="none"
                markerEnd="url(#pw-arrow)"
                className={isSel ? "stroke-primary" : "stroke-slate-400"}
                strokeWidth={isSel ? 2.5 : 1.5}
              />
              <path
                d={d}
                fill="none"
                stroke="transparent"
                strokeWidth={12}
                className="cursor-pointer"
                onClick={(ev) => {
                  ev.stopPropagation();
                  onSelect({ kind: "edge", id: e.id });
                }}
              />
              {e.condition ? (
                <text
                  x={(center(a).x + center(b).x) / 2}
                  y={(center(a).y + center(b).y) / 2 - 6}
                  textAnchor="middle"
                  fontSize={11}
                  className="fill-muted-foreground"
                >
                  {e.condition.length > 28 ? `${e.condition.slice(0, 28)}…` : e.condition}
                </text>
              ) : null}
            </g>
          );
        })}

        {nodes.map((n) => {
          const isSel = selected?.kind === "node" && selected.id === n.id;
          const x = n.position?.x || 0;
          const y = n.position?.y || 0;
          return (
            <g
              key={n.id}
              transform={`translate(${x}, ${y})`}
              className="cursor-move"
              onPointerDown={(e) => nodeDown(e, n)}
              onClick={(e) => nodeClick(e, n)}
            >
              <rect
                width={150}
                height={56}
                rx={8}
                strokeWidth={isSel ? 2.5 : 1}
                className={nodeClass(n.type, isSel)}
              />
              <text x={12} y={24} fontSize={12} fontWeight={600} className="pointer-events-none fill-foreground">
                {(n.name || n.id).slice(0, 12)}
              </text>
              <text x={12} y={42} fontSize={11} className="pointer-events-none fill-muted-foreground">
                {nodeSubtitle(n)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function center(n: DNode): Pos {
  return { x: (n.position?.x || 0) + 75, y: (n.position?.y || 0) + 28 };
}

function edgePath(a: DNode, b: DNode): string {
  const p1 = center(a);
  const p2 = center(b);
  const dx = Math.max(40, Math.abs(p2.x - p1.x) / 2);
  return `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
}

function nodeClass(type: string, selected: boolean): string {
  if (selected) return "fill-white stroke-primary";
  switch (type) {
    case "approval":
      return "fill-blue-50 stroke-blue-300";
    case "form":
      return "fill-emerald-50 stroke-emerald-300";
    case "script":
      return "fill-violet-50 stroke-violet-300";
    case "exclusive_gateway":
    case "parallel_gateway":
      return "fill-amber-50 stroke-amber-300";
    default:
      return "fill-slate-50 stroke-slate-300";
  }
}

function nodeSubtitle(n: DNode): string {
  let extra = NODE_TYPE_LABEL[n.type] || n.type;
  if (n.type === "approval") {
    const modes: Record<string, string> = { any: "或签", all: "并签", race: "竞签" };
    extra += ` · ${modes[n.signMode || "any"] || "或签"}`;
  }
  if (n.type === "parallel_gateway") extra += n.gatewayDirection === "join" ? " · 汇聚" : " · 分叉";
  return extra;
}

// ---------------------------------------------------------------- 右侧面板

function Panel({
  snap,
  selected,
  schemas,
  edges,
  update,
  onDeleteNode,
  onDeleteEdge,
}: {
  snap: DSnap;
  selected: Sel;
  schemas: Record<string, FormSchema>;
  edges: DEdge[];
  update: Updater;
  onDeleteNode: (id: string) => void;
  onDeleteEdge: (id: string) => void;
}) {
  const node = selected?.kind === "node" ? snap.nodes.find((n) => n.id === selected.id) : undefined;
  const edge = selected?.kind === "edge" ? snap.edges.find((e) => e.id === selected.id) : undefined;

  return (
    <Card className="h-fit p-4">
      {node ? (
        <NodePanel node={node} schemas={schemas} edges={edges} update={update} onDelete={() => onDeleteNode(node.id)} />
      ) : edge ? (
        <EdgePanel edge={edge} update={update} onDelete={() => onDeleteEdge(edge.id)} />
      ) : (
        <FlowPanel snap={snap} update={update} />
      )}
    </Card>
  );
}

function Section({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <div className="space-y-3 border-t pt-4 first:border-0 first:pt-0">
      {title ? <h3 className="text-sm font-semibold">{title}</h3> : null}
      {children}
    </div>
  );
}

function FlowPanel({ snap, update }: { snap: DSnap; update: Updater }) {
  const variables = snap.variables || [];

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">流程设置</h3>
      <div className="space-y-1.5">
        <Label htmlFor="flow-name">名称</Label>
        <Input
          id="flow-name"
          value={snap.name || ""}
          onChange={(e) =>
            update((s) => {
              s.name = e.target.value;
            })
          }
        />
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="flow-startable">可发起的角色（逗号分隔，空=所有人）</Label>
        <Input
          id="flow-startable"
          defaultValue={(snap.startableBy || []).join(",")}
          onBlur={(e) =>
            update((s) => {
              s.startableBy = e.target.value
                .split(",")
                .map((x) => x.trim())
                .filter(Boolean);
            })
          }
        />
      </div>

      <Section title="变量声明">
        <p className="text-xs text-muted-foreground">上下文契约：类型与必填。脚本/网关里用 ctx.变量名 引用。</p>
        <div className="space-y-2">
          {variables.map((v, idx) => (
            <div key={idx} className="flex items-center gap-2">
              <Input
                className="h-8 flex-1"
                value={v.name}
                placeholder="变量名"
                onChange={(e) =>
                  update((s) => {
                    s.variables![idx].name = e.target.value.trim();
                  })
                }
              />
              <Select
                value={v.type || "string"}
                onValueChange={(val) =>
                  update((s) => {
                    s.variables![idx].type = val;
                  })
                }
              >
                <SelectTrigger className="h-8 w-[100px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["string", "number", "amount", "bool", "date", "json"].map((t) => (
                    <SelectItem key={t} value={t}>
                      {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <label className="flex items-center gap-1 text-xs">
                <Checkbox
                  checked={!!v.required}
                  onCheckedChange={(checked) =>
                    update((s) => {
                      s.variables![idx].required = checked === true;
                    })
                  }
                />
                必填
              </label>
              <Button
                variant="ghost"
                size="icon"
                className="h-8 w-8 text-muted-foreground"
                onClick={() =>
                  update((s) => {
                    s.variables!.splice(idx, 1);
                  })
                }
              >
                <Trash2 />
              </Button>
            </div>
          ))}
        </div>
        <Button
          size="sm"
          variant="outline"
          onClick={() =>
            update((s) => {
              s.variables = s.variables || [];
              s.variables.push({ name: `var_${s.variables.length + 1}`, type: "string" });
            })
          }
        >
          <Plus /> 变量
        </Button>
      </Section>

      <p className="text-xs text-muted-foreground">点节点/边进行配置；点空白取消选择。</p>
    </div>
  );
}

function EdgePanel({ edge, update, onDelete }: { edge: DEdge; update: Updater; onDelete: () => void }) {
  return (
    <div className="space-y-4">
      <h3 className="font-semibold">边 {edge.id}</h3>
      <dl className="grid grid-cols-[60px_1fr] gap-y-1 text-sm">
        <dt className="text-muted-foreground">起点</dt>
        <dd>{edge.from}</dd>
        <dt className="text-muted-foreground">终点</dt>
        <dd>{edge.to}</dd>
      </dl>
      <div className="space-y-1.5">
        <Label htmlFor="edge-cond">条件表达式</Label>
        <Input
          id="edge-cond"
          value={edge.condition || ""}
          placeholder="留空或 true = 默认边"
          onChange={(e) =>
            update((s) => {
              const ed = s.edges.find((x) => x.id === edge.id);
              if (!ed) return;
              const v = e.target.value.trim();
              if (v) ed.condition = v;
              else delete ed.condition;
            })
          }
        />
        <p className="text-xs text-muted-foreground">只读表达式：ctx.变量 / verdict / 白名单函数（len、contains…）</p>
      </div>
      <Button variant="destructive" size="sm" onClick={onDelete}>
        <Trash2 /> 删除这条边
      </Button>
    </div>
  );
}

function NodePanel({
  node,
  schemas,
  edges,
  update,
  onDelete,
}: {
  node: DNode;
  schemas: Record<string, FormSchema>;
  edges: DEdge[];
  update: Updater;
  onDelete: () => void;
}) {
  const patch = (p: Partial<DNode>) =>
    update((s) => {
      const n = s.nodes.find((x) => x.id === node.id);
      if (n) Object.assign(n, p);
    });

  const outgoing = edges.filter((e) => e.from === node.id);

  return (
    <div className="space-y-4">
      <h3 className="font-semibold">节点 {node.id}</h3>
      <dl className="grid grid-cols-[70px_1fr] gap-y-1 text-sm">
        <dt className="text-muted-foreground">类型</dt>
        <dd>{NODE_TYPE_LABEL[node.type] || node.type}</dd>
        <dt className="text-muted-foreground">ID</dt>
        <dd className="font-mono text-xs">{node.id}</dd>
      </dl>
      <div className="space-y-1.5">
        <Label htmlFor="node-name">显示名</Label>
        <Input id="node-name" value={node.name || ""} onChange={(e) => patch({ name: e.target.value })} />
      </div>

      {(node.type === "approval" || node.type === "form") && (
        <Section title="审批人 / 填写人">
          <AssigneeEditor node={node} update={update} />
        </Section>
      )}

      {node.type === "approval" && (
        <Section title="签核规则">
          <div className="space-y-1.5">
            <Label>签核模式</Label>
            <Select value={node.signMode || "any"} onValueChange={(v) => patch({ signMode: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="any">或签（谁先同意算谁赢）</SelectItem>
                <SelectItem value="all">并签（会签）</SelectItem>
                <SelectItem value="race">竞签（先到先定音）</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label>被否决后</Label>
            <Select value={node.rejectStrategy || "to_start"} onValueChange={(v) => patch({ rejectStrategy: v })}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="to_start">退回发起人</SelectItem>
                <SelectItem value="terminate">否决终止</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </Section>
      )}

      {(node.type === "approval" || node.type === "form" || node.type === "start") && (
        <FormBindingEditor node={node} schemas={schemas} update={update} />
      )}

      {node.type === "script" && (
        <Section title="脚本">
          <p className="text-xs text-muted-foreground">入口 run(ctx, local, env, logger, now)；返回值写回上下文。</p>
          <Textarea
            className="min-h-[220px] font-mono text-xs"
            value={node.script || ""}
            onChange={(e) => patch({ script: e.target.value })}
          />
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1.5">
              <Label htmlFor="node-retries">失败重试次数</Label>
              <Input
                id="node-retries"
                type="number"
                min={0}
                max={5}
                value={node.retries || 0}
                onChange={(e) => patch({ retries: Number(e.target.value) || 0 })}
              />
            </div>
            <div className="space-y-1.5">
              <Label>onError 边</Label>
              <Select
                value={node.onErrorEdge || NONE}
                onValueChange={(v) => {
                  if (v === NONE) patch({ onErrorEdge: undefined });
                  else patch({ onErrorEdge: v });
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>（无：失败即挂起）</SelectItem>
                  {outgoing.map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {e.id} → {e.to}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>
        </Section>
      )}

      {node.type === "parallel_gateway" && (
        <Section title="网关方向">
          <Select value={node.gatewayDirection || "fork"} onValueChange={(v) => patch({ gatewayDirection: v })}>
            <SelectTrigger>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="fork">分叉（一条令牌变多条）</SelectItem>
              <SelectItem value="join">汇聚（等所有入边）</SelectItem>
            </SelectContent>
          </Select>
        </Section>
      )}

      {node.type !== "start" && node.type !== "end" ? (
        <Button variant="destructive" size="sm" onClick={onDelete}>
          <Trash2 /> 删除节点
        </Button>
      ) : null}
    </div>
  );
}

function AssigneeEditor({ node, update }: { node: DNode; update: Updater }) {
  const cfg: Assignee = node.assignee || { type: "managerOf", level: 1 };

  const patch = (p: Partial<Assignee>) =>
    update((s) => {
      const n = s.nodes.find((x) => x.id === node.id);
      if (!n) return;
      n.assignee = { ...(n.assignee || { type: "managerOf", level: 1 }), ...p };
    });

  const setType = (type: string) =>
    update((s) => {
      const n = s.nodes.find((x) => x.id === node.id);
      if (n) n.assignee = { type };
    });

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label>解析器</Label>
        <Select value={cfg.type} onValueChange={setType}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="user">指定用户</SelectItem>
            <SelectItem value="role">角色</SelectItem>
            <SelectItem value="managerOf">某人的 N 级主管</SelectItem>
            <SelectItem value="deptLeader">部门负责人</SelectItem>
            <SelectItem value="initiator">发起人</SelectItem>
            <SelectItem value="expr">表达式</SelectItem>
          </SelectContent>
        </Select>
      </div>

      {cfg.type === "user" && (
        <div className="space-y-1.5">
          <Label>用户 ID</Label>
          <Input value={cfg.id || ""} onChange={(e) => patch({ id: e.target.value.trim() })} />
        </div>
      )}
      {cfg.type === "role" && (
        <div className="space-y-1.5">
          <Label>角色 code</Label>
          <Input
            value={cfg.code || ""}
            placeholder="hr / legal / finance / risk / owner"
            onChange={(e) => patch({ code: e.target.value.trim() })}
          />
        </div>
      )}
      {cfg.type === "managerOf" && (
        <div className="grid grid-cols-2 gap-2">
          <div className="space-y-1.5">
            <Label>层级</Label>
            <Input
              type="number"
              min={1}
              max={5}
              value={cfg.level || 1}
              onChange={(e) => patch({ level: Number(e.target.value) || 1 })}
            />
          </div>
          <div className="space-y-1.5">
            <Label>相对谁</Label>
            <Input value={cfg.of || "initiator"} onChange={(e) => patch({ of: e.target.value.trim() || "initiator" })} />
          </div>
        </div>
      )}
      {cfg.type === "deptLeader" && (
        <div className="space-y-1.5">
          <Label>部门 ID（留空=发起人所在部门）</Label>
          <Input value={cfg.of || ""} onChange={(e) => patch({ of: e.target.value.trim() || undefined })} />
        </div>
      )}
      {cfg.type === "expr" && (
        <div className="space-y-1.5">
          <Label>表达式（求值为用户 ID 或列表）</Label>
          <Input value={cfg.expr || ""} placeholder="ctx.approver_id" onChange={(e) => patch({ expr: e.target.value.trim() })} />
        </div>
      )}
      {cfg.type === "initiator" && <p className="text-xs text-muted-foreground">由发起人本人处理。</p>}
    </div>
  );
}

function FormBindingEditor({ node, schemas, update }: { node: DNode; schemas: Record<string, FormSchema>; update: Updater }) {
  const formRef = node.formRef || "";
  const schema = formRef ? schemas[formRef] : undefined;
  const perms = node.fieldPermissions || {};

  function setFormRef(v: string) {
    update((s) => {
      const n = s.nodes.find((x) => x.id === node.id);
      if (!n) return;
      if (v === NONE) {
        delete n.formRef;
        delete n.fieldPermissions;
      } else {
        n.formRef = v;
      }
    });
  }

  function setAccess(name: string, access: string) {
    update((s) => {
      const n = s.nodes.find((x) => x.id === node.id);
      if (!n) return;
      const map = n.fieldPermissions || (n.fieldPermissions = {});
      const p: FieldPerm = { ...(map[name] || {}) };
      if (access === DEFAULT_ACCESS) delete p.access;
      else p.access = access;
      if (access !== "editable") p.required = false;
      if (!p.access && !p.required) delete map[name];
      else map[name] = p;
    });
  }

  function setRequired(name: string, required: boolean) {
    update((s) => {
      const n = s.nodes.find((x) => x.id === node.id);
      if (!n) return;
      const map = n.fieldPermissions || (n.fieldPermissions = {});
      const p: FieldPerm = { ...(map[name] || {}) };
      p.required = required;
      if (!p.access && !p.required) delete map[name];
      else map[name] = p;
    });
  }

  return (
    <Section title="表单与字段权限">
      <div className="space-y-1.5">
        <Label>绑定表单</Label>
        <Select value={formRef || NONE} onValueChange={setFormRef}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>（不绑定表单）</SelectItem>
            {Object.keys(schemas).map((k) => (
              <SelectItem key={k} value={k}>
                {k}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {schema ? (
        <div className="overflow-hidden rounded-md border">
          <table className="w-full text-xs">
            <thead className="bg-muted/50">
              <tr>
                <th className="px-2 py-1.5 text-left font-medium">字段</th>
                <th className="w-[110px] px-2 py-1.5 text-left font-medium">权限</th>
                <th className="w-[54px] px-2 py-1.5 text-left font-medium">必填</th>
              </tr>
            </thead>
            <tbody>
              {schema.fields
                .filter((f) => f.type !== "static" && f.name)
                .map((f) => {
                  const name = f.name as string;
                  const perm = perms[name] || {};
                  const editable = perm.access === "editable";
                  return (
                    <tr key={name} className="border-t">
                      <td className="px-2 py-1.5">{f.label || name}</td>
                      <td className="px-2 py-1.5">
                        <select
                          className="h-7 w-full rounded border border-input bg-transparent px-1 text-xs"
                          value={perm.access || DEFAULT_ACCESS}
                          onChange={(e) => setAccess(name, e.target.value)}
                        >
                          <option value={DEFAULT_ACCESS}>默认(只读)</option>
                          <option value="editable">可编辑</option>
                          <option value="readonly">只读</option>
                          <option value="hidden">隐藏</option>
                        </select>
                      </td>
                      <td className="px-2 py-1.5">
                        <Checkbox checked={!!perm.required} disabled={!editable} onCheckedChange={(v) => setRequired(name, v === true)} />
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      ) : null}
      <p className="text-xs text-muted-foreground">「节点 × 字段」矩阵：隐藏=不渲染，只读=灰化，可编辑=可填写。</p>
    </Section>
  );
}

// ---------------------------------------------------------------- 对话框

function JsonDialog({
  open,
  onOpenChange,
  snap,
  onApply,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  snap: DSnap;
  onApply: (next: DSnap) => void;
}) {
  const [text, setText] = useState("");
  const [key, setKey] = useState(0);

  useEffect(() => {
    if (open) {
      setText(JSON.stringify(snap, null, 2));
      setKey((k) => k + 1);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function apply() {
    try {
      const next = JSON.parse(text) as DSnap;
      if (!Array.isArray(next.nodes) || !Array.isArray(next.edges)) throw new Error("缺少 nodes / edges");
      onOpenChange(false);
      onApply(next);
    } catch (e) {
      toast.error("JSON 解析失败：" + (e instanceof Error ? e.message : "格式不对"));
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>流程 JSON</DialogTitle>
          <DialogDescription>设计器与 JSON 双向；改完点应用。</DialogDescription>
        </DialogHeader>
        <Textarea key={key} className="min-h-[420px] font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button onClick={apply}>应用</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface DryRunTrace {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: string;
  activationSeq: number;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

interface DryRunResult {
  ok: boolean;
  finished: boolean;
  status: string;
  outcome: string | null;
  steps: number;
  trace: DryRunTrace[];
  variables: Record<string, unknown>;
}

function DryRunDialog({
  open,
  onOpenChange,
  definitionKey,
  snap,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  definitionKey: string;
  snap: DSnap;
}) {
  const [text, setText] = useState("{}");
  const [result, setResult] = useState<DryRunResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const defaults: Record<string, unknown> = {};
    for (const v of snap.variables || []) if (v.default !== undefined) defaults[v.name] = v.default;
    setText(JSON.stringify(defaults, null, 2));
    setResult(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  async function run() {
    let variables: Record<string, unknown>;
    try {
      variables = JSON.parse(text || "{}");
    } catch {
      toast.error("变量 JSON 解析失败");
      return;
    }
    setBusy(true);
    try {
      const r = await api.post<DryRunResult>(`/definitions/${definitionKey}/dry-run`, { variables });
      setResult(r);
    } catch (e) {
      toast.error(errText(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>试跑（不落库）</DialogTitle>
          <DialogDescription>输入变量 JSON；人工节点会自动按「同意」处理。</DialogDescription>
        </DialogHeader>
        <Textarea className="min-h-[120px] font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} />
        {result ? (
          <div className="space-y-2 rounded-md border bg-muted/30 p-3 text-sm">
            <div className="font-medium">
              结果：{result.status}
              {result.outcome ? ` · ${result.outcome}` : ""} · 人工步骤 {result.steps}
            </div>
            <ol className="list-decimal space-y-1 pl-5 text-xs text-muted-foreground">
              {result.trace.map((t) => (
                <li key={`${t.nodeId}-${t.activationSeq}`}>
                  {t.nodeName}（{NODE_TYPE_LABEL[t.nodeType] || t.nodeType}）{t.status}
                  {t.error ? ` · ${t.error}` : ""}
                  {t.result && Object.keys(t.result).length ? ` · ${JSON.stringify(t.result)}` : ""}
                </li>
              ))}
            </ol>
            <div className="break-all font-mono text-xs text-muted-foreground">变量：{JSON.stringify(result.variables)}</div>
          </div>
        ) : null}
        <DialogFooter>
          <Button disabled={busy} onClick={run}>
            试跑
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
