export type ApiError = {
  code: string;
  message: string;
};

export type ApiResponse<T> = {
  success: boolean;
  data: T | null;
  error: ApiError | null;
  traceId: string | null;
};

export type HealthItem = {
  status: "UP" | "DOWN" | "SKIPPED" | "CHECKING" | string;
  detail?: string;
};

export type Settings = {
  maxSteps?: number;
  maxNodeActivations?: number;
  timezone?: string;
};

export type VariableDef = {
  name: string;
  type: string;
  required?: boolean;
  defaultValue?: unknown;
};

export type ServerNode = {
  id: string;
  type: string;
  name: string;
  position: { x: number; y: number };
  config: Record<string, unknown>;
};

export type ServerEdge = {
  id: string;
  from: string;
  to: string;
  condition?: string | null;
  defaultEdge?: boolean;
  order?: number;
};

export type DraftJson = {
  key: string;
  name: string;
  tenant: string;
  version?: number | null;
  settings: Settings;
  variables: VariableDef[];
  nodes: ServerNode[];
  edges: ServerEdge[];
};

export type DefinitionSummary = {
  id: number;
  key: string;
  name: string;
  category: string | null;
  description: string | null;
  status: string;
  currentVersion: number | null;
  draftRev: number;
  updatedAt: string;
};

export type DefinitionDetail = DefinitionSummary & {
  draft: DraftJson;
  createdAt: string;
};

export type ValidationIssue = {
  code: string;
  message: string;
  nodeId: string | null;
  edgeId: string | null;
};

export type ValidationResult = {
  valid: boolean;
  issues: ValidationIssue[];
};

export type VersionSummary = {
  id: number;
  version: number;
  contentHash: string;
  status: string;
  changeSummary: string | null;
  publishedBy: string | null;
  publishedAt: string;
};

export type InstanceSummary = {
  id: string;
  definitionKey: string;
  businessKey: string;
  title: string | null;
  initiator: string;
  status: string;
  outcome: string | null;
  version: number;
  currentNodeIds: string[];
  createdAt: string;
  endedAt: string | null;
};

export type NodeState = {
  id: number;
  nodeId: string;
  nodeType: string;
  status: string;
  tokenId: number | null;
  startedAt: string;
  endedAt: string | null;
};

export type TaskView = {
  id: number;
  instanceId: string;
  nodeId: string;
  assignee: string;
  status: string;
  verdict: string | null;
  comment: string | null;
  title: string | null;
  createdAt: string;
  completedAt: string | null;
};

export type TimelineItem = {
  action: string;
  actor: string;
  detail: unknown;
  createdAt: string;
};

export type InstanceDetail = {
  summary: InstanceSummary;
  nodes: NodeState[];
  tasks: TaskView[];
  variables: Record<string, unknown>;
  timeline: TimelineItem[];
};

const basePath = import.meta.env.BASE_URL.replace(/\/$/, "");

function withBase(path: string): string {
  return path.startsWith("/api") ? `${basePath}${path}` : path;
}

export async function requestJson<T>(path: string, init?: RequestInit): Promise<ApiResponse<T>> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (typeof localStorage !== "undefined") {
    headers["X-User-Id"] = localStorage.getItem("pipewise.user") || "anonymous";
  }
  if (init?.body) {
    headers["Content-Type"] = "application/json";
  }
  const response = await fetch(withBase(path), {
    ...init,
    credentials: "same-origin",
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) }
  });
  const body = (await response.json()) as ApiResponse<T>;
  if (response.status === 401 && typeof window !== "undefined") {
    window.dispatchEvent(new Event("pw-unauthorized"));
  }
  if (!response.ok && body.error) {
    return body;
  }
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}`);
  }
  return body;
}

export async function getJson<T>(path: string): Promise<ApiResponse<T>> {
  return requestJson<T>(path);
}

export const api = {
  login: (username: string, password: string) =>
    requestJson<{ username: string }>("/api/v1/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password })
    }),
  me: () => requestJson<{ username: string }>("/api/v1/auth/me"),
  logout: () =>
    requestJson<{ status: string }>("/api/v1/auth/logout", {
      method: "POST"
    }),

  listDefinitions: (keyword = "") =>
    requestJson<DefinitionSummary[]>(
      `/api/v1/definitions${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ""}`
    ),
  getDefinition: (key: string) =>
    requestJson<DefinitionDetail>(`/api/v1/definitions/${encodeURIComponent(key)}`),
  createDefinition: (body: { key: string; name: string; category?: string; description?: string }) =>
    requestJson<DefinitionDetail>("/api/v1/definitions", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  saveDraft: (key: string, body: { draftRev: number; draft: DraftJson }) =>
    requestJson<DefinitionDetail>(`/api/v1/definitions/${encodeURIComponent(key)}/draft`, {
      method: "PUT",
      body: JSON.stringify(body)
    }),
  validate: (key: string, draft: DraftJson) =>
    requestJson<ValidationResult>(`/api/v1/definitions/${encodeURIComponent(key)}/validate`, {
      method: "POST",
      body: JSON.stringify(draft)
    }),
  publish: (key: string, changeSummary: string) =>
    requestJson<VersionSummary>(`/api/v1/definitions/${encodeURIComponent(key)}/publish`, {
      method: "POST",
      body: JSON.stringify({ changeSummary })
    }),
  versions: (key: string) =>
    requestJson<VersionSummary[]>(`/api/v1/definitions/${encodeURIComponent(key)}/versions`),
  setDefault: (key: string, version: number) =>
    requestJson<{ defaultVersion: number }>(
      `/api/v1/definitions/${encodeURIComponent(key)}/versions/${version}/default`,
      { method: "POST" }
    ),

  listInstances: (status?: string) =>
    requestJson<InstanceSummary[]>(
      `/api/v1/instances${status ? `?status=${encodeURIComponent(status)}` : ""}`
    ),
  getInstance: (id: string) =>
    requestJson<InstanceDetail>(`/api/v1/instances/${encodeURIComponent(id)}`),
  createInstance: (body: {
    key: string;
    businessKey: string;
    title?: string;
    initiator?: string;
    variables?: Record<string, unknown>;
  }) =>
    requestJson<InstanceDetail>("/api/v1/instances", {
      method: "POST",
      body: JSON.stringify(body)
    }),
  listTasks: (status = "CREATED") =>
    requestJson<TaskView[]>(`/api/v1/tasks?status=${encodeURIComponent(status)}`),
  completeTask: (id: number, verdict: "approve" | "reject" | "return", comment: string) =>
    requestJson<TaskView>(`/api/v1/tasks/${id}/complete`, {
      method: "POST",
      body: JSON.stringify({ verdict, comment })
    }),
  addSign: (id: number, assignee: string) =>
    requestJson<TaskView>(`/api/v1/tasks/${id}/add-sign`, {
      method: "POST",
      body: JSON.stringify({ assignee })
    }),
  transfer: (id: number, assignee: string) =>
    requestJson<TaskView>(`/api/v1/tasks/${id}/transfer`, {
      method: "POST",
      body: JSON.stringify({ assignee })
    }),
  withdrawInstance: (id: string) =>
    requestJson<{ status: string }>(`/api/v1/instances/${encodeURIComponent(id)}/withdraw`, {
      method: "POST"
    })
};
