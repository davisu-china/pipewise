import { useCallback, useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import {
  addEdge,
  Background,
  Controls,
  Handle,
  MiniMap,
  Position,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type NodeProps
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Button } from "../components/ui/button";
import {
  api,
  type DefinitionDetail,
  type DraftJson,
  type ServerEdge,
  type ServerNode,
  type Settings,
  type ValidationIssue,
  type VariableDef,
  type VersionSummary
} from "../lib/api";

type FlowNodeData = {
  label: string;
  nodeType: string;
  config: Record<string, unknown>;
};

type FlowEdgeData = {
  condition?: string;
  defaultEdge?: boolean;
  order?: number;
};

type FlowNode = Node<FlowNodeData>;
type FlowEdge = Edge<FlowEdgeData>;

type TypeMeta = { label: string; color: string };

const typeMeta: Record<string, TypeMeta> = {
  start: { label: "开始", color: "#1A6357" },
  end: { label: "结束", color: "#28527A" },
  approval: { label: "审批", color: "#B45309" },
  exclusive_gateway: { label: "排他网关", color: "#6B21A8" },
  form: { label: "表单", color: "#0F766E" },
  script: { label: "脚本", color: "#7C2D12" }
};

const palette = ["start", "approval", "exclusive_gateway", "end"];

const defaultSettings: Settings = {
  maxSteps: 1000,
  maxNodeActivations: 100,
  timezone: "Asia/Shanghai"
};

function PipeNode({ data, selected }: NodeProps<FlowNode>) {
  const meta = typeMeta[data.nodeType] ?? { label: data.nodeType, color: "#64748b" };
  return (
    <div
      className={`min-w-[150px] rounded-lg border-2 bg-white px-3 py-2 shadow-sm ${
        selected ? "border-slate-900" : "border-slate-200"
      }`}
      style={{ borderLeftColor: meta.color, borderLeftWidth: 5 }}
    >
      <Handle type="target" position={Position.Left} />
      <div className="text-xs font-semibold text-slate-900">{data.label}</div>
      <div className="text-[10px] text-slate-500">{meta.label}</div>
      <Handle type="source" position={Position.Right} />
    </div>
  );
}

const nodeTypes = { pipewise: PipeNode };

function toFlowNodes(nodes: ServerNode[]): FlowNode[] {
  return nodes.map((node) => ({
    id: node.id,
    type: "pipewise",
    position: node.position ?? { x: 0, y: 0 },
    data: {
      label: node.name || node.id,
      nodeType: node.type,
      config: node.config ?? {}
    }
  }));
}

function toFlowEdges(edges: ServerEdge[]): FlowEdge[] {
  return edges.map((edge) => ({
    id: edge.id,
    source: edge.from,
    target: edge.to,
    type: "smoothstep",
    label: edge.condition || (edge.defaultEdge ? "默认" : ""),
    data: {
      condition: edge.condition ?? undefined,
      defaultEdge: Boolean(edge.defaultEdge),
      order: edge.order
    }
  }));
}

function buildDraft(
  key: string,
  name: string,
  settings: Settings,
  variables: VariableDef[],
  nodes: FlowNode[],
  edges: FlowEdge[]
): DraftJson {
  return {
    key,
    name,
    tenant: "default",
    version: null,
    settings,
    variables,
    nodes: nodes.map((node) => ({
      id: node.id,
      type: node.data.nodeType,
      name: node.data.label,
      position: { x: node.position.x, y: node.position.y },
      config: node.data.config ?? {}
    })),
    edges: edges.map((edge, index) => ({
      id: edge.id,
      from: edge.source,
      to: edge.target,
      condition: edge.data?.condition ?? null,
      defaultEdge: Boolean(edge.data?.defaultEdge),
      order: edge.data?.order ?? index + 1
    }))
  };
}

export default function DesignerPage() {
  const { key } = useParams<{ key: string }>();
  const [detail, setDetail] = useState<DefinitionDetail | null>(null);
  const [name, setName] = useState("");
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const [variables, setVariables] = useState<VariableDef[]>([]);
  const [draftRev, setDraftRev] = useState(1);
  const [versions, setVersions] = useState<VersionSummary[]>([]);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedEdgeId, setSelectedEdgeId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [jsonOpen, setJsonOpen] = useState(false);
  const [jsonText, setJsonText] = useState("");

  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>([]);

  const loadVersions = useCallback(async (definitionKey: string) => {
    const response = await api.versions(definitionKey);
    if (response.success && response.data) {
      setVersions(response.data);
    }
  }, []);

  const load = useCallback(async () => {
    if (!key) {
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const response = await api.getDefinition(key);
      if (response.success && response.data) {
        const next = response.data;
        setDetail(next);
        setName(next.name);
        setDraftRev(next.draftRev);
        setSettings(next.draft.settings ?? defaultSettings);
        setVariables(next.draft.variables ?? []);
        setNodes(toFlowNodes(next.draft.nodes ?? []));
        setEdges(toFlowEdges(next.draft.edges ?? []));
        setSelectedNodeId(null);
        setSelectedEdgeId(null);
        await loadVersions(key);
      } else {
        setError(response.error?.message ?? "加载失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "加载失败");
    } finally {
      setLoading(false);
    }
  }, [key, loadVersions, setEdges, setNodes]);

  useEffect(() => {
    void load();
  }, [load]);

  const selectedNode = useMemo(
    () => nodes.find((node) => node.id === selectedNodeId),
    [nodes, selectedNodeId]
  );
  const selectedEdge = useMemo(
    () => edges.find((edge) => edge.id === selectedEdgeId),
    [edges, selectedEdgeId]
  );

  const draft = () => buildDraft(key ?? "", name, settings, variables, nodes, edges);

  const save = async () => {
    if (!key) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.saveDraft(key, { draftRev, draft: draft() });
      if (response.success && response.data) {
        setDraftRev(response.data.draftRev);
        setDetail(response.data);
        setMessage("草稿已保存");
      } else {
        setError(response.error?.message ?? "保存失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "保存失败");
    } finally {
      setBusy(false);
    }
  };

  const validate = async () => {
    if (!key) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.validate(key, draft());
      if (response.success && response.data) {
        setIssues(response.data.issues);
        setMessage(response.data.valid ? "校验通过" : `发现 ${response.data.issues.length} 个问题`);
      } else {
        setError(response.error?.message ?? "校验失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "校验失败");
    } finally {
      setBusy(false);
    }
  };

  const publish = async () => {
    if (!key) return;
    const summary = window.prompt("变更说明（可留空）", "");
    if (summary === null) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const response = await api.publish(key, summary);
      if (response.success && response.data) {
        setMessage(`已发布 v${response.data.version}`);
        setIssues([]);
        await load();
      } else {
        setError(response.error?.message ?? "发布失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "发布失败");
    } finally {
      setBusy(false);
    }
  };

  const makeDefault = async (version: number) => {
    if (!key) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api.setDefault(key, version);
      if (response.success) {
        setMessage(`默认版本已切换为 v${version}`);
        await load();
      } else {
        setError(response.error?.message ?? "切换失败");
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "切换失败");
    } finally {
      setBusy(false);
    }
  };

  const addNode = (type: string) => {
    if (type === "start" && nodes.some((node) => node.data.nodeType === "start")) {
      setError("只能有一个开始节点");
      return;
    }
    const id = `${type}_${Date.now()}`;
    const meta = typeMeta[type] ?? { label: type, color: "#64748b" };
    setNodes((current) => [
      ...current,
      {
        id,
        type: "pipewise",
        position: { x: 180 + current.length * 36, y: 120 + current.length * 24 },
        data: {
          label: `${meta.label}${current.length + 1}`,
          nodeType: type,
          config: type === "approval" ? { signMode: "any" } : {}
        }
      }
    ]);
    setSelectedNodeId(id);
    setSelectedEdgeId(null);
  };

  const onConnect = useCallback(
    (connection: Connection) => {
      setEdges((current) =>
        addEdge<FlowEdge>(
          {
            ...connection,
            id: `e_${Date.now()}`,
            type: "smoothstep",
            label: "",
            data: {}
          },
          current
        )
      );
    },
    [setEdges]
  );

  const updateSelectedNode = (patch: Partial<FlowNodeData>) => {
    if (!selectedNodeId) return;
    setNodes((current) =>
      current.map((node) =>
        node.id === selectedNodeId ? { ...node, data: { ...node.data, ...patch } } : node
      )
    );
  };

  const updateConfig = (field: string, value: string) => {
    if (!selectedNode) return;
    updateSelectedNode({
      config: { ...selectedNode.data.config, [field]: value }
    });
  };

  const updateSelectedEdge = (patch: Partial<FlowEdgeData>) => {
    if (!selectedEdgeId) return;
    setEdges((current) =>
      current.map((edge) => {
        if (edge.id !== selectedEdgeId) return edge;
        const data = { ...edge.data, ...patch };
        return {
          ...edge,
          data,
          label: data.condition || (data.defaultEdge ? "默认" : "")
        };
      })
    );
  };

  const removeSelected = () => {
    if (selectedNodeId) {
      setNodes((current) => current.filter((node) => node.id !== selectedNodeId));
      setEdges((current) =>
        current.filter((edge) => edge.source !== selectedNodeId && edge.target !== selectedNodeId)
      );
      setSelectedNodeId(null);
      return;
    }
    if (selectedEdgeId) {
      setEdges((current) => current.filter((edge) => edge.id !== selectedEdgeId));
      setSelectedEdgeId(null);
    }
  };

  const addVariable = () =>
    setVariables((current) => [
      ...current,
      { name: `var${current.length + 1}`, type: "string", required: false }
    ]);

  const updateVariable = (index: number, patch: Partial<VariableDef>) =>
    setVariables((current) =>
      current.map((variable, currentIndex) =>
        currentIndex === index ? { ...variable, ...patch } : variable
      )
    );

  const removeVariable = (index: number) =>
    setVariables((current) => current.filter((_, currentIndex) => currentIndex !== index));

  const openJson = () => {
    setJsonText(JSON.stringify(draft(), null, 2));
    setJsonOpen(true);
  };

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText) as DraftJson;
      setSettings(parsed.settings ?? defaultSettings);
      setVariables(parsed.variables ?? []);
      setNodes(toFlowNodes(parsed.nodes ?? []));
      setEdges(toFlowEdges(parsed.edges ?? []));
      setName(parsed.name ?? name);
      setJsonOpen(false);
      setMessage("JSON 已应用，记得保存草稿");
    } catch {
      setError("JSON 解析失败");
    }
  };

  if (loading) {
    return <main className="p-8 text-sm text-slate-500">加载定义中…</main>;
  }
  if (error && !detail) {
    return (
      <main className="p-8">
        <div className="rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">
          {error}
        </div>
        <Link to="/" className="mt-4 inline-block text-sm text-slate-600 underline">
          返回流程列表
        </Link>
      </main>
    );
  }

  return (
    <div className="flex h-[calc(100vh-57px)] flex-col">
      <div className="flex flex-wrap items-center gap-3 border-b border-slate-200 bg-white px-4 py-2">
        <Link to="/" className="text-sm text-slate-500 hover:text-slate-900">
          ← 返回
        </Link>
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          className="h-8 w-56 rounded-md border border-slate-200 px-2 text-sm font-medium outline-none focus:border-slate-400"
        />
        <span className="font-mono text-xs text-slate-400">{key}</span>
        {detail?.currentVersion && (
          <span className="rounded-full bg-slate-100 px-2 py-0.5 font-mono text-[11px] text-slate-600">
            current v{detail.currentVersion}
          </span>
        )}
        <div className="ml-auto flex items-center gap-2">
          <Button className="h-8 bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50" onClick={openJson}>
            JSON
          </Button>
          <Button className="h-8" disabled={busy} onClick={() => void save()}>
            保存草稿
          </Button>
          <Button className="h-8 bg-slate-600 hover:bg-slate-500" disabled={busy} onClick={() => void validate()}>
            校验
          </Button>
          <Button className="h-8 bg-emerald-700 hover:bg-emerald-600" disabled={busy} onClick={() => void publish()}>
            发布
          </Button>
        </div>
      </div>

      {message && (
        <div className="border-b border-emerald-200 bg-emerald-50 px-4 py-2 text-xs text-emerald-700">
          {message}
        </div>
      )}
      {error && (
        <div className="border-b border-red-200 bg-red-50 px-4 py-2 text-xs text-red-700">
          {error}
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <aside className="w-44 shrink-0 overflow-y-auto border-r border-slate-200 bg-white p-3">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-400">添加节点</p>
          <div className="mt-2 grid gap-2">
            {palette.map((type) => (
              <button
                key={type}
                type="button"
                onClick={() => addNode(type)}
                className="rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-xs font-medium text-slate-700 hover:border-slate-400 hover:bg-slate-50"
              >
                {typeMeta[type]?.label ?? type}
              </button>
            ))}
          </div>
          <div className="mt-5 border-t border-slate-100 pt-3 text-[11px] leading-5 text-slate-500">
            拖动画布、连接节点；点击节点或连线在右侧配置。排他网关必须有一条默认边。
          </div>
        </aside>

        <div className="min-h-0 min-w-0 flex-1">
          <ReactFlow
            nodes={nodes}
            edges={edges}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            nodeTypes={nodeTypes}
            onNodeClick={(_, node) => {
              setSelectedNodeId(node.id);
              setSelectedEdgeId(null);
            }}
            onEdgeClick={(_, edge) => {
              setSelectedEdgeId(edge.id);
              setSelectedNodeId(null);
            }}
            onPaneClick={() => {
              setSelectedNodeId(null);
              setSelectedEdgeId(null);
            }}
            fitView
            proOptions={{ hideAttribution: true }}
          >
            <Background gap={16} size={1} />
            <Controls />
            <MiniMap pannable zoomable />
          </ReactFlow>
        </div>

        <aside className="w-80 shrink-0 overflow-y-auto border-l border-slate-200 bg-white p-3">
          {selectedNode ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">节点配置</h3>
                <button type="button" onClick={removeSelected} className="text-xs text-red-600 hover:underline">
                  删除
                </button>
              </div>
              <label className="grid gap-1 text-xs text-slate-600">
                名称
                <input
                  value={selectedNode.data.label}
                  onChange={(event) => updateSelectedNode({ label: event.target.value })}
                  className="h-8 rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-slate-400"
                />
              </label>
              <p className="text-xs text-slate-500">
                类型：<span className="font-mono">{selectedNode.data.nodeType}</span>
              </p>
              {selectedNode.data.nodeType === "approval" && (
                <>
                  <label className="grid gap-1 text-xs text-slate-600">
                    签核模式
                    <select
                      value={String(selectedNode.data.config.signMode ?? "any")}
                      onChange={(event) => updateConfig("signMode", event.target.value)}
                      className="h-8 rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-slate-400"
                    >
                      <option value="any">或签 any</option>
                      <option value="all">并签 all</option>
                      <option value="race">竞签 race</option>
                    </select>
                  </label>
                  <label className="grid gap-1 text-xs text-slate-600">
                    审批人表达式（P3 生效）
                    <input
                      value={String(selectedNode.data.config.assignee ?? "")}
                      onChange={(event) => updateConfig("assignee", event.target.value)}
                      placeholder="managerOf(ctx.applicantId)"
                      className="h-8 rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-slate-400"
                    />
                  </label>
                </>
              )}
              {selectedNode.data.nodeType === "form" && (
                <label className="grid gap-1 text-xs text-slate-600">
                  表单引用 formRef
                  <input
                    value={String(selectedNode.data.config.formRef ?? "")}
                    onChange={(event) => updateConfig("formRef", event.target.value)}
                    className="h-8 rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-slate-400"
                  />
                </label>
              )}
              {selectedNode.data.nodeType === "script" && (
                <label className="grid gap-1 text-xs text-slate-600">
                  脚本引用 scriptRef
                  <input
                    value={String(selectedNode.data.config.scriptRef ?? "")}
                    onChange={(event) => updateConfig("scriptRef", event.target.value)}
                    className="h-8 rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-slate-400"
                  />
                </label>
              )}
              {selectedNode.data.nodeType === "exclusive_gateway" && (
                <p className="rounded-md bg-amber-50 px-2 py-1.5 text-[11px] text-amber-700">
                  排他网关：至少一条出边设为「默认」；非默认边必须填写条件。
                </p>
              )}
            </div>
          ) : selectedEdge ? (
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <h3 className="text-sm font-semibold">连线配置</h3>
                <button type="button" onClick={removeSelected} className="text-xs text-red-600 hover:underline">
                  删除
                </button>
              </div>
              <p className="font-mono text-[11px] text-slate-500">
                {selectedEdge.source} → {selectedEdge.target}
              </p>
              <label className="grid gap-1 text-xs text-slate-600">
                条件表达式
                <input
                  value={selectedEdge.data?.condition ?? ""}
                  onChange={(event) => updateSelectedEdge({ condition: event.target.value })}
                  placeholder="ctx.amount > 5000"
                  className="h-8 rounded-md border border-slate-200 px-2 text-sm outline-none focus:border-slate-400"
                />
              </label>
              <label className="flex items-center gap-2 text-xs text-slate-600">
                <input
                  type="checkbox"
                  checked={Boolean(selectedEdge.data?.defaultEdge)}
                  onChange={(event) => updateSelectedEdge({ defaultEdge: event.target.checked })}
                />
                默认边（条件兜底）
              </label>
            </div>
          ) : (
            <p className="text-sm text-slate-500">点击节点或连线进行配置。</p>
          )}

          <div className="mt-5 border-t border-slate-100 pt-4">
            <div className="flex items-center justify-between">
              <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">变量</h4>
              <button type="button" onClick={addVariable} className="text-xs text-slate-600 hover:underline">
                + 添加
              </button>
            </div>
            <div className="mt-2 space-y-2">
              {variables.map((variable, index) => (
                <div key={`${variable.name}-${index}`} className="grid grid-cols-[1fr_74px_20px] gap-1">
                  <input
                    value={variable.name}
                    onChange={(event) => updateVariable(index, { name: event.target.value })}
                    className="h-7 rounded border border-slate-200 px-2 font-mono text-[11px] outline-none focus:border-slate-400"
                  />
                  <select
                    value={variable.type}
                    onChange={(event) => updateVariable(index, { type: event.target.value })}
                    className="h-7 rounded border border-slate-200 px-1 text-[11px] outline-none focus:border-slate-400"
                  >
                    {["string", "number", "decimal", "bool", "date", "datetime", "json", "array", "file", "user", "org"].map((type) => (
                      <option key={type} value={type}>{type}</option>
                    ))}
                  </select>
                  <button type="button" onClick={() => removeVariable(index)} className="text-xs text-slate-400 hover:text-red-600">
                    ×
                  </button>
                </div>
              ))}
              {variables.length === 0 && <p className="text-[11px] text-slate-400">暂无变量</p>}
            </div>
          </div>

          <div className="mt-5 border-t border-slate-100 pt-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">校验结果</h4>
            {issues.length === 0 ? (
              <p className="mt-2 text-[11px] text-slate-400">暂无问题（点击「校验」检查）</p>
            ) : (
              <ul className="mt-2 space-y-1.5">
                {issues.map((issue, index) => (
                  <li key={`${issue.code}-${index}`} className="text-[11px] leading-5 text-red-700">
                    <span className="font-mono text-red-400">{issue.code}</span> {issue.message}
                  </li>
                ))}
              </ul>
            )}
          </div>

          <div className="mt-5 border-t border-slate-100 pt-4">
            <h4 className="text-xs font-semibold uppercase tracking-wide text-slate-400">版本</h4>
            <div className="mt-2 space-y-2">
              {versions.length === 0 && <p className="text-[11px] text-slate-400">尚未发布</p>}
              {versions.map((version) => (
                <div key={version.id} className="flex items-center justify-between gap-2 text-[11px]">
                  <div className="min-w-0">
                    <div className="font-medium text-slate-700">
                      v{version.version}
                      {detail?.currentVersion === version.version && (
                        <span className="ml-1 text-emerald-600">默认</span>
                      )}
                    </div>
                    <div className="truncate font-mono text-slate-400">{version.contentHash.slice(0, 12)}</div>
                  </div>
                  {detail?.currentVersion !== version.version && (
                    <button
                      type="button"
                      onClick={() => void makeDefault(version.version)}
                      className="shrink-0 text-slate-600 hover:underline"
                    >
                      设为默认
                    </button>
                  )}
                </div>
              ))}
            </div>
          </div>
        </aside>
      </div>

      {jsonOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 p-4">
          <div className="flex h-[80vh] w-full max-w-3xl flex-col rounded-xl bg-white p-4 shadow-xl">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-semibold">JSON 草稿</h3>
              <button type="button" onClick={() => setJsonOpen(false)} className="text-sm text-slate-500">
                关闭
              </button>
            </div>
            <textarea
              value={jsonText}
              onChange={(event) => setJsonText(event.target.value)}
              className="mt-3 min-h-0 flex-1 rounded-md border border-slate-200 p-3 font-mono text-xs outline-none focus:border-slate-400"
            />
            <div className="mt-3 flex justify-end gap-2">
              <Button className="h-8 bg-white text-slate-700 ring-1 ring-slate-200 hover:bg-slate-50" onClick={() => setJsonOpen(false)}>
                取消
              </Button>
              <Button className="h-8" onClick={applyJson}>应用 JSON</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
