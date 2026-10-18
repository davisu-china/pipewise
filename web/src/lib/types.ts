// 与后端 JSON 对齐的类型（camelCase）。

export interface DemoUser {
  id: string;
  name: string;
  roles: string[];
  token: string;
}

export interface Me {
  id: string;
  name: string;
  deptId: string | null;
  managerId: string | null;
  roles: string[];
}

export interface UserInfo {
  id: string;
  name: string;
  deptId: string | null;
  managerId: string | null;
  roles: string[];
}

export interface Issue {
  level: "error" | "warning";
  code: string;
  message: string;
  node?: string | null;
  edge?: string | null;
}

export interface FlowNode {
  id: string;
  type: string;
  name?: string;
  position?: { x: number; y: number };
  [key: string]: unknown;
}

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  condition?: string;
  [key: string]: unknown;
}

export interface FlowSnapshot {
  key?: string;
  name?: string;
  version?: number;
  startableBy?: string[];
  variables?: Array<{ name: string; type?: string; required?: boolean; default?: unknown }>;
  nodes: FlowNode[];
  edges: FlowEdge[];
  [key: string]: unknown;
}

export interface VersionInfo {
  id: number;
  version: number;
  status: string;
  publishedBy: string | null;
  publishedAt: string | null;
  createdAt: string;
}

export interface Definition {
  id: number;
  key: string;
  name: string;
  category: string | null;
  description: string | null;
  status: string;
  currentVersion: number | null;
  currentVersionId: number | null;
  draftRev: number;
  versions?: VersionInfo[];
  draft?: FlowSnapshot;
  canStart?: boolean;
  startableBy?: string[];
}

export interface FieldDef {
  name: string;
  label?: string;
  type: string;
  required?: boolean;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
  help?: string;
  min?: number;
  max?: number;
  max_length?: number;
  pattern?: string;
  validate?: string;
  validate_message?: string;
  text?: string;
  default?: unknown;
}

export interface FormSchema {
  key: string;
  name: string;
  version?: number;
  fields: FieldDef[];
}

export interface FormAsset {
  id: number;
  key: string;
  name: string;
  category: string | null;
  draftSchema: FormSchema & { fields?: FieldDef[] };
  draftRev: number;
  published: { version: number; schema: FormSchema } | null;
  versions?: Array<{ id: number; version: number; status: string; publishedAt: string | null }>;
}

export interface FormField {
  name: string | null;
  label?: string;
  type: string;
  access?: "editable" | "readonly" | "hidden";
  required?: boolean;
  value?: unknown;
  options?: Array<{ label: string; value: string }>;
  placeholder?: string;
  help?: string;
  min?: number;
  max?: number;
  max_length?: number;
  pattern?: string;
  text?: string;
}

export interface FormPayload {
  form_key: string;
  form_name: string;
  form_version?: number;
  node_id: string;
  fields: FormField[];
}

export interface TaskInfo {
  id: number;
  instanceId: number;
  nodeId: string;
  nodeName: string;
  kind: string;
  assignee: string;
  assigneeName: string;
  status: string;
  verdict: string | null;
  comment: string | null;
  createdAt: string;
  completedAt: string | null;
  businessKey?: string;
  title?: string | null;
  definitionKey?: string;
  instanceStatus?: string;
}

export interface TimelineItem {
  at: string;
  kind: "audit" | "variable" | "task" | string;
  action: string;
  actor: string | null;
  detail: Record<string, unknown> | null;
  nodeInstanceId?: number | null;
}

export interface InstanceInfo {
  id: number;
  definitionKey: string;
  definitionName: string;
  version: number;
  businessKey: string;
  title: string | null;
  initiator: string;
  initiatorName: string;
  status: string;
  outcome: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  openTasks?: TaskInfo[];
  currentNodes?: Array<{ nodeId: string; nodeName: string; assignees: string[] }>;
  variables?: Record<string, unknown>;
  tasks?: TaskInfo[];
  timeline?: TimelineItem[];
  nodeInstances?: Array<{
    id: number;
    nodeId: string;
    nodeName: string;
    nodeType: string;
    status: string;
    activationSeq: number;
    result?: Record<string, unknown> | null;
    error?: string | null;
    startedAt?: string | null;
    endedAt?: string | null;
  }>;
}

export interface DryRunTrace {
  nodeId: string;
  nodeName: string;
  nodeType: string;
  status: string;
  activationSeq: number;
  result?: Record<string, unknown> | null;
  error?: string | null;
}

export interface DryRunResult {
  ok: boolean;
  finished: boolean;
  status: string;
  outcome: string | null;
  steps: number;
  trace: DryRunTrace[];
  variables: Record<string, unknown>;
}

export interface TaskFormResponse {
  form: FormPayload | null;
  nodeId: string;
  nodeName?: string;
  nodeType?: string;
  signMode?: string;
  instance: { id: number; status: string; title: string | null; businessKey: string };
  task: TaskInfo;
}

export interface AdminStats {
  instancesByStatus: Record<string, number>;
  openTasks: number;
  outboxPending: number;
  outboxDead: number;
  byDefinition: Array<{ definitionKey: string; total: number; running: number }>;
  failedInstances: InstanceInfo[];
}
