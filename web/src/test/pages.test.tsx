import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import App from "@/App";
import { AuthProvider } from "@/lib/auth";

function reply(body: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response);
}

const me = { id: "u_admin", name: "系统管理员", deptId: null, managerId: null, roles: ["admin"] };

const draft = {
  key: "leave_approval",
  name: "请假审批",
  startableBy: [],
  variables: [{ name: "leave_days", type: "number", required: true }],
  nodes: [
    { id: "start", type: "start", name: "发起申请", position: { x: 80, y: 200 } },
    {
      id: "mgr",
      type: "approval",
      name: "直属主管审批",
      position: { x: 300, y: 200 },
      assignee: { type: "managerOf", level: 1 },
      signMode: "any",
      rejectStrategy: "to_start",
    },
    { id: "end", type: "end", name: "结束", position: { x: 520, y: 200 } },
  ],
  edges: [
    { id: "e1", from: "start", to: "mgr" },
    { id: "e2", from: "mgr", to: "end" },
  ],
};

const definition = {
  id: 1,
  key: "leave_approval",
  name: "请假审批",
  category: "演示",
  description: "种子流程",
  status: "active",
  currentVersion: 1,
  currentVersionId: 1,
  draftRev: 1,
  draft,
};

const task = {
  id: 22,
  instanceId: 9,
  nodeId: "mgr",
  nodeName: "直属主管审批",
  kind: "approval",
  assignee: "u_admin",
  assigneeName: "系统管理员",
  status: "CREATED",
  verdict: null,
  comment: null,
  createdAt: "2026-10-18T14:31:03+08:00",
  completedAt: null,
  businessKey: "smoke-1",
  title: "冒烟测试",
  definitionKey: "leave_approval",
  instanceStatus: "RUNNING",
};

const instance = {
  id: 9,
  definitionKey: "leave_approval",
  definitionName: "请假审批",
  version: 1,
  businessKey: "smoke-1",
  title: "冒烟测试",
  initiator: "u_zhangsan",
  initiatorName: "张三",
  status: "RUNNING",
  outcome: null,
  createdAt: "2026-10-18T14:31:03+08:00",
  startedAt: "2026-10-18T14:31:03+08:00",
  endedAt: null,
  openTasks: [task],
  currentNodes: [{ nodeId: "mgr", nodeName: "直属主管审批", assignees: ["系统管理员"] }],
  variables: { leave_days: 3, leave_reason: "联调" },
  tasks: [task],
  nodeInstances: [
    {
      id: 50,
      nodeId: "mgr",
      nodeName: "直属主管审批",
      nodeType: "approval",
      status: "WAITING",
      activationSeq: 1,
      result: null,
      error: null,
      startedAt: "2026-10-18T14:31:03+08:00",
      endedAt: null,
    },
  ],
  timeline: [
    {
      at: "2026-10-18T14:31:03+08:00",
      kind: "audit",
      action: "instance.created",
      actor: "u_zhangsan",
      detail: { definition: "leave_approval" },
      nodeInstanceId: null,
    },
  ],
};

const formSchemas = {
  items: {
    leave_form: {
      key: "leave_form",
      name: "请假单",
      fields: [
        { name: "leave_days", type: "number", label: "请假天数", required: true },
        { name: "leave_reason", type: "textarea", label: "请假事由", required: true },
        { name: "mgr_comment", type: "textarea", label: "主管意见" },
      ],
    },
  },
};

const taskForm = {
  form: {
    form_key: "leave_form",
    form_name: "请假单",
    form_version: 1,
    node_id: "mgr",
    fields: [
      { name: "leave_days", label: "请假天数", type: "number", access: "readonly", required: false, value: 3 },
      { name: "leave_reason", label: "请假事由", type: "textarea", access: "readonly", required: false, value: "联调" },
      { name: "mgr_comment", label: "主管意见", type: "textarea", access: "editable", required: true, value: null },
    ],
  },
  nodeId: "mgr",
  nodeName: "直属主管审批",
  nodeType: "approval",
  signMode: "any",
  instance: { id: 9, status: "RUNNING", title: "冒烟测试", businessKey: "smoke-1" },
  task,
};

const stats = {
  instancesByStatus: { RUNNING: 1 },
  openTasks: 1,
  outboxPending: 0,
  outboxDead: 0,
  byDefinition: [{ definitionKey: "leave_approval", total: 1, running: 1 }],
  failedInstances: [],
};

const outbox = {
  items: [
    {
      id: 1,
      instanceId: 9,
      type: "instance.created",
      status: "DELIVERED",
      attempts: 1,
      nextRetryAt: null,
      createdAt: "2026-10-18T14:31:03+08:00",
      deliveredAt: "2026-10-18T14:31:04+08:00",
    },
  ],
};

function installFetchMock() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
      const headers = (init?.headers || {}) as Record<string, string>;
      // 演示账号接口是公开的；其余接口必须带令牌，和线上行为一致。
      if (!url.endsWith("/dev/demo-users") && !headers["X-PipeWise-Token"]) {
        return reply({ error: { code: "UNAUTHORIZED", message: "请先登录（缺少访问令牌）" } }, 401);
      }
      if (url.endsWith("/dev/demo-users")) return reply({ items: [{ ...me, token: "tok_admin" }] });
      if (url.endsWith("/me")) return reply(me);
      if (url.endsWith("/users")) return reply({ items: [me] });
      if (url.includes("/definitions/leave_approval/form-schemas")) return reply(formSchemas);
      if (url.includes("/definitions/leave_approval/versions/1")) return reply({ snapshot: draft });
      if (url.endsWith("/definitions/leave_approval")) return reply(definition);
      if (url.endsWith("/definitions")) return reply({ items: [definition] });
      if (url.endsWith("/forms")) return reply({ items: [] });
      if (url.includes("/tasks?")) return reply({ items: [task] });
      if (url.endsWith("/tasks/22/form")) return reply(taskForm);
      if (url.endsWith("/instances/9")) return reply(instance);
      if (url.endsWith("/instances")) return reply({ items: [instance] });
      if (url.endsWith("/admin/stats")) return reply(stats);
      if (url.includes("/admin/outbox")) return reply(outbox);
      if (url.endsWith("/admin/webhooks")) return reply({ items: [] });
      if (url.includes("/admin/dev-sink")) return reply({ items: [] });
      return reply({ error: { code: "NOT_FOUND", message: `no mock: ${url}` } }, 404);
    }),
  );
}

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <AuthProvider>
        <App />
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  localStorage.clear();
  installFetchMock();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("页面渲染冒烟", () => {
  it("初始化时把默认演示账号写入本地令牌（防首屏 401）", async () => {
    renderAt("/definitions");
    expect(await screen.findByRole("heading", { name: "流程定义" })).toBeInTheDocument();
    expect(localStorage.getItem("pipewise.token")).toBe("tok_admin");
  });

  it("流程定义列表", async () => {
    renderAt("/definitions");
    expect(await screen.findByRole("heading", { name: "流程定义" })).toBeInTheDocument();
    expect(await screen.findByText("请假审批")).toBeInTheDocument();
    expect(screen.getByText("leave_approval")).toBeInTheDocument();
  });

  it("设计器画布", async () => {
    renderAt("/designer/leave_approval");
    expect(await screen.findByText("发起申请")).toBeInTheDocument();
    expect(screen.getByText("直属主管审批")).toBeInTheDocument();
    expect(screen.getByText("保存草稿")).toBeInTheDocument();
  });

  it("待办列表", async () => {
    renderAt("/tasks");
    expect(await screen.findByRole("heading", { name: "我的待办" })).toBeInTheDocument();
    expect(await screen.findByText("冒烟测试")).toBeInTheDocument();
  });

  it("任务详情渲染表单与操作", async () => {
    renderAt("/tasks/22");
    expect(await screen.findByText("主管意见")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /同意/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /否决/ })).toBeInTheDocument();
  });

  it("实例列表", async () => {
    renderAt("/instances");
    expect(await screen.findByText("实例（全部）")).toBeInTheDocument();
    expect(await screen.findByText("冒烟测试")).toBeInTheDocument();
  });

  it("实例详情", async () => {
    renderAt("/instances/9");
    expect(await screen.findByText("概要")).toBeInTheDocument();
    expect(screen.getByText("上下文变量")).toBeInTheDocument();
    expect(screen.getByText("管理员干预")).toBeInTheDocument();
  });

  it("发起流程", async () => {
    renderAt("/start/leave_approval");
    expect(await screen.findByText("发起：请假审批")).toBeInTheDocument();
    expect(screen.getByText("业务单号 *")).toBeInTheDocument();
  });

  it("运维页", async () => {
    renderAt("/admin");
    expect(await screen.findByRole("heading", { name: "运维" })).toBeInTheDocument();
    expect(await screen.findByText("事件 Outbox")).toBeInTheDocument();
    expect(screen.getByText("Webhook 订阅")).toBeInTheDocument();
  });
});
