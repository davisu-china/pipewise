/* PipeWise 前端：原生 JS + hash 路由（无构建步骤）。
 *
 * 设计原则：前端只做渲染与交互；**权限与校验以服务端返回为准**
 *（表单字段的 access/required 是服务端按节点×字段权限矩阵算出来的）。
 */
"use strict";

// ----------------------------------------------------------------- 基础工具

// 允许把应用挂在子路径下（如 https://site/pipewise/）：从当前页面推导根路径。
// 注意用 ".." 的相对解析对 hash 路由是安全的：pathname 不含 hash。
const ROOT = new URL(".", location.href).pathname.replace(/\/$/, "");
const API = ROOT + "/api/v1";
const state = {
  token: localStorage.getItem("pw_token") || "tok_zhangsan",
  users: [],
  me: null,
};

function h(tag, attrs = {}, ...kids) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === "class") e.className = v;
    else if (k === "on") for (const [ev, fn] of Object.entries(v)) e.addEventListener(ev, fn);
    else if (k === "html") e.innerHTML = v;
    else if (k === "style") e.setAttribute("style", v);
    else e.setAttribute(k, v);
  }
  for (const kid of kids.flat(9)) {
    if (kid === null || kid === undefined || kid === false) continue;
    e.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  }
  return e;
}

function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

class ApiErr extends Error {
  constructor(code, message, details, status) {
    super(message);
    this.code = code; this.details = details || {}; this.status = status;
  }
}

async function api(path, { method = "GET", body, headers = {} } = {}) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      Authorization: "Bearer " + state.token,
      ...headers,
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null;
  try { json = await res.json(); } catch { /* 空响应 */ }
  if (!res.ok || (json && json.error)) {
    const err = (json && json.error) || {};
    throw new ApiErr(err.code || "HTTP_" + res.status, err.message || "请求失败", err.details, res.status);
  }
  return json;
}

let toastTimer = null;
function toast(msg, isError = false) {
  const t = document.getElementById("toast");
  t.textContent = msg;
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 5200 : 2600);
}

function openModal(title, body, foot) {
  document.getElementById("modal-title").textContent = title;
  const b = document.getElementById("modal-body");
  clear(b); b.append(body);
  const f = document.getElementById("modal-foot");
  clear(f); (foot || []).forEach((x) => f.append(x));
  document.getElementById("modal").hidden = false;
}
function closeModal() { document.getElementById("modal").hidden = true; }

function fmtTime(s) {
  if (!s) return "—";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return s;
  return d.toLocaleString("zh-CN", { hour12: false });
}
const fmtVal = (v) => (v === null || v === undefined ? "—" : typeof v === "object" ? JSON.stringify(v) : String(v));

function statusTag(status, outcome) {
  const map = {
    RUNNING: ["green", "运行中"], COMPLETED: ["blue", "已完成"], TERMINATED: ["red", "已终止"],
    FAILED: ["red", "失败"], SUSPENDED: ["amber", "已挂起"], CREATED: ["", "待启动"],
  };
  const [cls, label] = map[status] || ["", status];
  const extra = outcome === "rejected" ? "· 否决" : "";
  return h("span", { class: "tag " + cls }, label + extra);
}

function nodeTag(type) {
  const m = { start: "开始", end: "结束", approval: "审批", form: "表单", script: "脚本",
    exclusive_gateway: "排他网关", parallel_gateway: "并行网关" };
  return m[type] || type;
}

// ----------------------------------------------------------------- 路由

const view = document.getElementById("view");
const routes = [
  [/^#\/definitions$/, viewDefinitions],
  [/^#\/designer\/([^/]+)$/, viewDesigner],
  [/^#\/forms$/, viewForms],
  [/^#\/tasks$/, viewTasks],
  [/^#\/task\/(\d+)$/, viewTask],
  [/^#\/instances$/, viewInstances],
  [/^#\/instance\/(\d+)$/, viewInstance],
  [/^#\/start\/([^/]+)$/, viewStart],
  [/^#\/admin$/, viewAdmin],
];

async function render() {
  const hash = location.hash || "#/definitions";
  document.querySelectorAll(".nav a").forEach((a) => a.classList.remove("active"));
  const navKey = hash.split("/")[1];
  const link = document.querySelector(`.nav a[data-nav="${navKey}"]`);
  if (link) link.classList.add("active");
  clear(view);
  for (const [re, fn] of routes) {
    const m = hash.match(re);
    if (m) {
      try {
        await fn(...m.slice(1));
      } catch (e) {
        view.append(h("div", { class: "card empty" }, e.message || String(e)));
      }
      return;
    }
  }
  view.append(h("div", { class: "card empty" }, "页面不存在"));
}

// ----------------------------------------------------------------- 流程定义列表

async function viewDefinitions() {
  const data = await api("/definitions");
  const isAdmin = (state.me?.roles || []).includes("admin");
  const isDesigner = (state.me?.roles || []).includes("designer") || isAdmin;

  view.append(
    h("div", { class: "page-head" },
      h("div", {}, h("h1", {}, "流程定义"), h("div", { class: "sub" }, "定义 → 发布版本 → 创建实例。已发布版本不可变，实例永远钉在创建时的版本上。")),
      isDesigner ? h("button", { class: "btn primary", on: { click: () => newDefinitionDialog() } }, "＋ 新建流程") : null,
    ),
  );

  const card = h("div", { class: "card" });
  const table = h("table", {},
    h("thead", {}, h("tr", {}, ["KEY", "名称", "状态", "当前版本", "操作"].map((x) => h("th", {}, x)))),
  );
  const tb = h("tbody");
  for (const d of data.items) {
    const actions = h("div", { class: "row" });
    if (isDesigner) actions.append(h("a", { class: "btn sm", href: `#/designer/${d.key}` }, "设计"));
    if (isAdmin) {
      actions.append(h("button", {
        class: "btn sm", on: { click: () => publishDefinition(d.key) },
      }, d.currentVersion ? "发布草稿" : "发布"));
      if (d.status === "active") {
        actions.append(h("button", {
          class: "btn sm danger", on: { click: () => retireDefinition(d.key) },
        }, "下线"));
      }
    }
    actions.append(h("a", { class: "btn sm", href: `#/start/${d.key}` }, "发起"));
    tb.append(h("tr", {},
      h("td", { class: "mono" }, d.key),
      h("td", {}, d.name, d.description ? h("div", { class: "hint" }, d.description) : null),
      h("td", {}, d.status === "active" ? h("span", { class: "tag green" }, "启用") : h("span", { class: "tag" }, d.status)),
      h("td", {}, d.currentVersion ? `v${d.currentVersion}` : h("span", { class: "tag amber" }, "未发布")),
      h("td", {}, actions),
    ));
  }
  if (!data.items.length) tb.append(h("tr", {}, h("td", { colspan: 5, class: "empty" }, "还没有流程定义")));
  table.append(tb);
  card.append(table);
  view.append(card);

  const versionsCard = h("div", { class: "card" },
    h("div", { class: "card-head" }, h("h2", {}, "版本说明")),
    h("div", { class: "card-body" },
      h("ul", { style: "margin:0;padding-left:18px" },
        h("li", {}, "草稿可随意编辑；**提交**生成不可变版本，**管理员发布**后新实例默认使用它。"),
        h("li", {}, "已跑实例不受新版本影响；下线只拦截新实例（PRD §6.2）。"),
        h("li", {}, "设计器里的「试跑」会在一个会回滚的事务里真跑一遍，用来验证分支与脚本。"),
      )),
  );
  view.append(versionsCard);
}

async function publishDefinition(key) {
  if (!confirm(`发布 ${key} 的最新草稿？`)) return;
  try {
    const r = await api(`/definitions/${key}/publish`, { method: "POST" });
    toast(`已发布 v${r.version}`);
  } catch (e) {
    if (e.code === "VALIDATION_FAILED") {
      showIssues(e.details.issues || []);
    } else toast(e.message, true);
  }
}

async function retireDefinition(key) {
  if (!confirm(`下线 ${key}？已在跑的实例不受影响，但不能再发起新实例。`)) return;
  await api(`/definitions/${key}/retire`, { method: "POST" });
  toast("已下线");
  render();
}

function newDefinitionDialog() {
  const key = h("input", { type: "text", placeholder: "expense_approval（小写字母/数字/下划线）" });
  const name = h("input", { type: "text", placeholder: "费用报销审批" });
  const body = h("div", { class: "stack" },
    h("div", { class: "field" }, h("label", {}, "Key（跨版本不变的稳定标识）"), key),
    h("div", { class: "field" }, h("label", {}, "名称"), name),
  );
  const submit = h("button", {
    class: "btn primary",
    on: {
      click: async () => {
        try {
          const d = await api("/definitions", { method: "POST", body: { key: key.value.trim(), name: name.value.trim() } });
          closeModal();
          location.hash = `#/designer/${d.key}`;
        } catch (e) { toast(e.message, true); }
      },
    },
  }, "创建");
  openModal("新建流程", body, [h("button", { class: "btn", on: { click: closeModal } }, "取消"), submit]);
}

function showIssues(issues) {
  const box = h("div", { class: "issues" });
  if (!issues.length) box.append(h("div", { class: "issue" }, "没有发现问题"));
  for (const i of issues) {
    box.append(h("div", { class: "issue " + (i.level === "error" ? "error" : "warning") },
      `${i.level === "error" ? "错误" : "警告"} · ${i.code} · ${i.message}` +
      (i.node ? `（节点 ${i.node}）` : "") + (i.edge ? `（边 ${i.edge}）` : "")));
  }
  openModal("校验结果", box, [h("button", { class: "btn primary", on: { click: closeModal } }, "知道了")]);
}

// ----------------------------------------------------------------- 设计器

const NODE_PALETTE = [
  ["approval", "审批节点"], ["form", "表单节点"], ["script", "脚本节点"],
  ["exclusive_gateway", "排他网关"], ["parallel_gateway", "并行网关"], ["end", "结束节点"],
];

async function viewDesigner(key) {
  const def = await api(`/definitions/${key}`);
  const formsData = await api("/forms");
  const formSchemas = {};
  for (const f of formsData.items) if (f.published) formSchemas[f.key] = f.published.schema;

  const D = {
    key, def, snap: JSON.parse(JSON.stringify(def.draft)), rev: def.draftRev,
    selected: null, connectFrom: null, formSchemas,
    isAdmin: (state.me?.roles || []).includes("admin"),
    isDesigner: (state.me?.roles || []).includes("designer") || (state.me?.roles || []).includes("admin"),
  };
  layoutMissing(D.snap);

  const canvasWrap = h("div", { class: "canvas-wrap" });
  const panel = h("div", { class: "panel" });
  const toolbar = h("div", { class: "toolbar" });

  const editor = h("div", { class: "designer" },
    h("div", {}, toolbar, canvasWrap), panel);
  view.append(
    h("div", { class: "page-head" },
      h("div", {},
        h("h1", {}, def.name || key),
        h("div", { class: "sub" }, `${key} · 草稿 rev ${def.draftRev} · 当前版本 ${def.currentVersion ? "v" + def.currentVersion : "未发布"}`),
      ),
      h("a", { class: "btn", href: "#/definitions" }, "← 返回列表"),
    ),
    editor,
  );

  const redraw = () => { drawCanvas(D, canvasWrap, redraw, drawPanel); drawPanel(D, panel, redraw); drawToolbar(D, toolbar, redraw); };
  drawToolbar(D, toolbar, redraw);
  redraw();
}

function layoutMissing(snap) {
  const level = {};
  const start = (snap.nodes || []).find((n) => n.type === "start");
  const out = {};
  for (const e of snap.edges || []) (out[e.from] = out[e.from] || []).push(e.to);
  if (start) {
    const q = [[start.id, 0]];
    level[start.id] = 0;
    while (q.length) {
      const [id, lv] = q.shift();
      for (const to of out[id] || []) if (level[to] === undefined) { level[to] = lv + 1; q.push([to, lv + 1]); }
    }
  }
  const per = {};
  for (const n of snap.nodes || []) {
    const lv = level[n.id] ?? 0;
    per[lv] = (per[lv] || 0) + 1;
    if (!n.position) n.position = { x: 60 + lv * 190, y: 60 + (per[lv] - 1) * 100 };
  }
}

function drawToolbar(D, toolbar, redraw) {
  clear(toolbar);
  const typeSel = h("select", { style: "width:auto" }, ...NODE_PALETTE.map(([v, label]) => h("option", { value: v }, label)));
  toolbar.append(
    h("span", { class: "hint" }, "添加："), typeSel,
    h("button", {
      class: "btn sm", on: { click: () => addNode(D, typeSel.value, redraw) },
    }, "＋ 节点"),
    h("button", {
      class: "btn sm" + (D.connectFrom !== null ? " primary" : ""),
      on: {
        click: () => { D.connectFrom = D.connectFrom === null ? "" : null; redraw(); },
      },
    }, D.connectFrom === null ? "连线" : "连线中：点起点→终点（取消）"),
    h("span", { class: "grow" }),
    h("button", { class: "btn sm", on: { click: () => validateDraft(D) } }, "校验"),
    h("button", { class: "btn sm", on: { click: () => dryRunDialog(D) } }, "试跑"),
    h("button", { class: "btn sm", on: { click: () => jsonDialog(D, redraw) } }, "JSON"),
    D.isDesigner ? h("button", { class: "btn sm primary", on: { click: () => saveDraft(D, redraw) } }, "保存草稿") : null,
    D.isDesigner ? h("button", { class: "btn sm", on: { click: () => submitDraft(D) } }, "提交发布") : null,
    D.isAdmin ? h("button", { class: "btn sm primary", on: { click: () => publishDefinition(D.key) } }, "发布") : null,
  );
}

function addNode(D, type, redraw) {
  let i = 1;
  while ((D.snap.nodes || []).some((n) => n.id === `${type}_${i}`)) i++;
  const id = `${type}_${i}`;
  const node = { id, type, name: nodeTag(type) + i, position: { x: 320, y: 380 } };
  if (type === "approval") Object.assign(node, { assignee: { type: "managerOf", level: 1 }, signMode: "any", rejectStrategy: "to_start" });
  if (type === "form") node.assignee = { type: "role", code: "hr" };
  if (type === "script") node.script = "def run(ctx, local, env, logger, now):\n    return {}\n";
  if (type === "exclusive_gateway") node.name = "条件分支";
  if (type === "parallel_gateway") node.gatewayDirection = "fork";
  D.snap.nodes.push(node);
  D.selected = { kind: "node", id };
  redraw();
}

function drawCanvas(D, wrap, redraw, drawPanelFn) {
  clear(wrap);
  const nodes = D.snap.nodes || [];
  const edges = D.snap.edges || [];
  const xs = nodes.map((n) => (n.position?.x || 0) + 180);
  const ys = nodes.map((n) => (n.position?.y || 0) + 90);
  const W = Math.max(1100, ...xs) + 60;
  const H = Math.max(700, ...ys) + 60;
  const svgNS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(svgNS, "svg");
  svg.setAttribute("width", W); svg.setAttribute("height", H);
  svg.innerHTML = `<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#9fb0c9"/></marker></defs>`;

  const nodeById = Object.fromEntries(nodes.map((n) => [n.id, n]));
  const center = (n) => ({ x: (n.position?.x || 0) + 75, y: (n.position?.y || 0) + 28 });

  for (const e of edges) {
    const a = nodeById[e.from], b = nodeById[e.to];
    if (!a || !b) continue;
    const p1 = center(a), p2 = center(b);
    const dx = Math.max(40, Math.abs(p2.x - p1.x) / 2);
    const d = `M ${p1.x} ${p1.y} C ${p1.x + dx} ${p1.y}, ${p2.x - dx} ${p2.y}, ${p2.x} ${p2.y}`;
    const sel = D.selected?.kind === "edge" && D.selected.id === e.id;
    const path = document.createElementNS(svgNS, "path");
    path.setAttribute("d", d); path.setAttribute("class", "edge" + (sel ? " sel" : ""));
    path.setAttribute("marker-end", "url(#arrow)");
    svg.appendChild(path);
    const hit = document.createElementNS(svgNS, "path");
    hit.setAttribute("d", d); hit.setAttribute("class", "edge-hit");
    hit.addEventListener("click", (ev) => { ev.stopPropagation(); D.selected = { kind: "edge", id: e.id }; drawPanelFn(D, document.querySelector(".panel"), redraw); drawCanvas(D, wrap, redraw, drawPanelFn); });
    svg.appendChild(hit);
    if (e.condition) {
      const t = document.createElementNS(svgNS, "text");
      t.setAttribute("x", (p1.x + p2.x) / 2); t.setAttribute("y", (p1.y + p2.y) / 2 - 6);
      t.setAttribute("text-anchor", "middle"); t.setAttribute("class", "edge-label");
      t.textContent = e.condition.length > 28 ? e.condition.slice(0, 28) + "…" : e.condition;
      svg.appendChild(t);
    }
  }

  for (const n of nodes) {
    const g = document.createElementNS(svgNS, "g");
    const kind = n.type === "parallel_gateway" || n.type === "exclusive_gateway" ? "gateway" : n.type;
    g.setAttribute("class", "node " + kind + (D.selected?.kind === "node" && D.selected.id === n.id ? " sel" : ""));
    g.setAttribute("transform", `translate(${n.position?.x || 0}, ${n.position?.y || 0})`);
    const rect = document.createElementNS(svgNS, "rect");
    rect.setAttribute("width", 150); rect.setAttribute("height", 56);
    g.appendChild(rect);
    const t1 = document.createElementNS(svgNS, "text");
    t1.setAttribute("x", 12); t1.setAttribute("y", 24); t1.setAttribute("class", "title");
    t1.textContent = (n.name || n.id).slice(0, 12);
    g.appendChild(t1);
    const t2 = document.createElementNS(svgNS, "text");
    t2.setAttribute("x", 12); t2.setAttribute("y", 42); t2.setAttribute("class", "kind");
    let extra = nodeTag(n.type);
    if (n.type === "approval") extra += " · " + ({ any: "或签", all: "并签", race: "竞签" }[n.signMode] || "或签");
    if (n.type === "parallel_gateway") extra += n.gatewayDirection === "join" ? " · 汇聚" : " · 分叉";
    t2.textContent = extra;
    g.appendChild(t2);
    svg.appendChild(g);

    g.addEventListener("pointerdown", (ev) => startDrag(ev, D, n, redraw));
    g.addEventListener("click", (ev) => {
      ev.stopPropagation();
      if (D.connectFrom !== null) {
        if (D.connectFrom === "") { D.connectFrom = n.id; toast("已选起点，再点终点"); redraw(); return; }
        if (D.connectFrom === n.id) { D.connectFrom = null; redraw(); return; }
        addEdge(D, D.connectFrom, n.id); D.connectFrom = null; redraw(); return;
      }
      D.selected = { kind: "node", id: n.id };
      redraw();
    });
  }
  wrap.appendChild(svg);
  svg.addEventListener("click", () => { D.selected = null; redraw(); });
}

function startDrag(ev, D, node, redraw) {
  if (D.connectFrom !== null) return;
  const svg = ev.currentTarget.ownerSVGElement;
  const pt = svg.createSVGPoint();
  const toSvg = (e) => { pt.x = e.clientX; pt.y = e.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
  const start = toSvg(ev);
  const orig = { ...(node.position || { x: 0, y: 0 }) };
  let moved = false;
  const move = (e) => {
    const p = toSvg(e);
    const dx = p.x - start.x, dy = p.y - start.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) moved = true;
    node.position = { x: Math.round((orig.x + dx) / 10) * 10, y: Math.round((orig.y + dy) / 10) * 10 };
    ev.currentTarget.setAttribute("transform", `translate(${node.position.x}, ${node.position.y})`);
  };
  const up = () => {
    window.removeEventListener("pointermove", move);
    window.removeEventListener("pointerup", up);
    if (moved) redraw();
  };
  window.addEventListener("pointermove", move);
  window.addEventListener("pointerup", up);
}

function addEdge(D, from, to) {
  let i = 1;
  while ((D.snap.edges || []).some((e) => e.id === `e${i}`)) i++;
  D.snap.edges.push({ id: `e${i}`, from, to });
}

function drawPanel(D, panel, redraw) {
  clear(panel);
  const node = D.selected?.kind === "node" ? (D.snap.nodes || []).find((n) => n.id === D.selected.id) : null;
  const edge = D.selected?.kind === "edge" ? (D.snap.edges || []).find((e) => e.id === D.selected.id) : null;

  if (!node && !edge) {
    panel.append(h("h3", {}, "流程设置"));
    const nameInput = h("input", { type: "text", value: D.snap.name || "", on: { change: (e) => (D.snap.name = e.target.value) } });
    panel.append(h("div", { class: "section" },
      h("div", { class: "field" }, h("label", {}, "名称"), nameInput),
      h("div", { class: "field", style: "margin-top:8px" },
        h("label", {}, "可发起的角色（逗号分隔，空=所有人）"),
        h("input", {
          type: "text", value: (D.snap.startableBy || []).join(","),
          on: { change: (e) => { const v = e.target.value.split(",").map((s) => s.trim()).filter(Boolean); D.snap.startableBy = v; } },
        })),
    ));
    panel.append(h("div", { class: "section" },
      h("h3", {}, "变量声明"),
      h("div", { class: "hint", style: "margin-bottom:8px" }, "上下文契约：类型与必填。脚本/网关里用 ctx.变量名 引用。"),
      renderVariablesEditor(D, redraw),
    ));
    panel.append(h("div", { class: "section" }, h("div", { class: "hint" }, "点节点/边进行配置；点空白取消选择。")));
    return;
  }

  if (edge) {
    panel.append(h("h3", {}, `边 ${edge.id}`));
    const cond = h("input", { type: "text", value: edge.condition || "", placeholder: "留空或 true = 默认边" });
    cond.addEventListener("change", () => (edge.condition = cond.value.trim() || undefined));
    panel.append(h("div", { class: "section" },
      h("div", { class: "kv" }, h("dt", {}, "起点"), h("dd", {}, edge.from), h("dt", {}, "终点"), h("dd", {}, edge.to)),
      h("div", { class: "field", style: "margin-top:8px" }, h("label", {}, "条件表达式"), cond,
        h("div", { class: "hint" }, "只读表达式：ctx.变量 / verdict / 白名单函数（len、contains…）")),
      h("button", {
        class: "btn sm danger", style: "margin-top:10px",
        on: { click: () => { D.snap.edges = D.snap.edges.filter((x) => x.id !== edge.id); D.selected = null; redraw(); } },
      }, "删除这条边"),
    ));
    return;
  }

  panel.append(h("h3", {}, `节点 ${node.id}`));
  const name = h("input", { type: "text", value: node.name || "" });
  name.addEventListener("change", () => (node.name = name.value));
  panel.append(h("div", { class: "section" },
    h("div", { class: "kv" },
      h("dt", {}, "类型"), h("dd", {}, nodeTag(node.type)),
      h("dt", {}, "ID"), h("dd", { class: "mono" }, node.id)),
    h("div", { class: "field", style: "margin-top:8px" }, h("label", {}, "显示名"), name),
  ));

  if (node.type === "approval" || node.type === "form") {
    panel.append(h("div", { class: "section" }, h("h3", {}, "审批人 / 填写人"), assigneeEditor(node)));
    if (node.type === "approval") {
      const mode = h("select", {},
        ...[["any", "或签（谁先同意算谁赢）"], ["all", "并签（会签）"], ["race", "竞签（先到先定音）"]]
          .map(([v, l]) => h("option", { value: v, selected: (node.signMode || "any") === v }, l)));
      mode.addEventListener("change", () => { node.signMode = mode.value; redraw(); });
      const rej = h("select", {},
        ...[["to_start", "退回发起人"], ["terminate", "否决终止"]]
          .map(([v, l]) => h("option", { value: v, selected: (node.rejectStrategy || "terminate") === v }, l)));
      rej.addEventListener("change", () => (node.rejectStrategy = rej.value));
      panel.append(h("div", { class: "section" },
        h("div", { class: "field" }, h("label", {}, "签核模式"), mode),
        h("div", { class: "field", style: "margin-top:8px" }, h("label", {}, "被否决后"), rej),
      ));
    }
    panel.append(h("div", { class: "section" }, formBindingEditor(D, node, redraw)));
  }

  if (node.type === "script") {
    const code = h("textarea", { class: "mono", style: "min-height:220px" });
    code.value = node.script || "";
    code.addEventListener("change", () => (node.script = code.value));
    const retries = h("input", { type: "number", min: 0, max: 5, value: node.retries || 0 });
    retries.addEventListener("change", () => (node.retries = Number(retries.value) || 0));
    const outs = (D.snap.edges || []).filter((e) => e.from === node.id);
    const onErr = h("select", {}, h("option", { value: "" }, "（无：失败即挂起）"),
      ...outs.map((e) => h("option", { value: e.id, selected: node.onErrorEdge === e.id }, `${e.id} → ${e.to}`)));
    onErr.addEventListener("change", () => { node.onErrorEdge = onErr.value || undefined; });
    panel.append(h("div", { class: "section" },
      h("h3", {}, "脚本"),
      h("div", { class: "hint", style: "margin-bottom:6px" }, "入口 run(ctx, local, env, logger, now)；返回值写回上下文。"),
      code,
      h("div", { class: "grid2", style: "margin-top:8px" },
        h("div", { class: "field" }, h("label", {}, "失败重试次数"), retries),
        h("div", { class: "field" }, h("label", {}, "onError 边"), onErr)),
    ));
  }

  if (node.type === "parallel_gateway") {
    const dir = h("select", {},
      ...[["fork", "分叉（一条令牌变多条）"], ["join", "汇聚（等所有入边）"]]
        .map(([v, l]) => h("option", { value: v, selected: (node.gatewayDirection || "fork") === v }, l)));
    dir.addEventListener("change", () => { node.gatewayDirection = dir.value; redraw(); });
    panel.append(h("div", { class: "section" }, h("div", { class: "field" }, h("label", {}, "方向"), dir)));
  }

  if (node.type === "start") {
    panel.append(h("div", { class: "section" }, formBindingEditor(D, node, redraw)));
  }

  if (node.type !== "start" && node.type !== "end") {
    panel.append(h("div", { class: "section" },
      h("button", {
        class: "btn sm danger",
        on: {
          click: () => {
            D.snap.nodes = D.snap.nodes.filter((n) => n.id !== node.id);
            D.snap.edges = D.snap.edges.filter((e) => e.from !== node.id && e.to !== node.id);
            D.selected = null; redraw();
          },
        },
      }, "删除节点"),
    ));
  }
}

function assigneeEditor(node) {
  const cfg = node.assignee || (node.assignee = { type: "managerOf", level: 1 });
  const type = h("select", {},
    ...[["user", "指定用户"], ["role", "角色"], ["managerOf", "某人的 N 级主管"], ["deptLeader", "部门负责人"], ["initiator", "发起人"], ["expr", "表达式"]]
      .map(([v, l]) => h("option", { value: v, selected: cfg.type === v }, l)));
  const params = h("div", { class: "stack", style: "margin-top:8px" });
  const renderParams = () => {
    clear(params);
    if (cfg.type === "user") {
      params.append(h("div", { class: "field" }, h("label", {}, "用户 ID"),
        h("input", { type: "text", value: cfg.id || "", on: { change: (e) => (cfg.id = e.target.value.trim()) } })));
    } else if (cfg.type === "role") {
      params.append(h("div", { class: "field" }, h("label", {}, "角色 code"),
        h("input", { type: "text", value: cfg.code || "", placeholder: "hr / legal / finance / risk / owner", on: { change: (e) => (cfg.code = e.target.value.trim()) } })));
    } else if (cfg.type === "managerOf") {
      params.append(h("div", { class: "grid2" },
        h("div", { class: "field" }, h("label", {}, "层级"), h("input", { type: "number", min: 1, max: 5, value: cfg.level || 1, on: { change: (e) => (cfg.level = Number(e.target.value) || 1) } })),
        h("div", { class: "field" }, h("label", {}, "相对谁"), h("input", { type: "text", value: cfg.of || "initiator", on: { change: (e) => (cfg.of = e.target.value.trim() || "initiator") } })),
      ));
    } else if (cfg.type === "deptLeader") {
      params.append(h("div", { class: "field" }, h("label", {}, "部门 ID（留空=发起人所在部门）"),
        h("input", { type: "text", value: cfg.of || "", on: { change: (e) => (cfg.of = e.target.value.trim() || undefined) } })));
    } else if (cfg.type === "expr") {
      params.append(h("div", { class: "field" }, h("label", {}, "表达式（求值为用户 ID 或列表）"),
        h("input", { type: "text", value: cfg.expr || "", placeholder: "ctx.approver_id", on: { change: (e) => (cfg.expr = e.target.value.trim()) } })));
    }
  };
  type.addEventListener("change", () => { cfg.type = type.value; renderParams(); });
  renderParams();
  return h("div", {}, h("div", { class: "field" }, h("label", {}, "解析器"), type), params);
}

function formBindingEditor(D, node, redraw) {
  const sel = h("select", {}, h("option", { value: "" }, "（不绑定表单）"),
    ...Object.keys(D.formSchemas).map((k) => h("option", { value: k, selected: node.formRef === k }, k)));
  const box = h("div", { class: "stack", style: "margin-top:8px" });
  const renderPerms = () => {
    clear(box);
    const schema = D.formSchemas[node.formRef];
    if (!schema) return;
    const tbl = h("table", { class: "perm-table" },
      h("thead", {}, h("tr", {}, ["字段", "权限", "必填"].map((x) => h("th", {}, x)))));
    const tb = h("tbody");
    for (const f of schema.fields) {
      if (f.type === "static") continue;
      const perm = (node.fieldPermissions ||= {})[f.name] || {};
      const acc = h("select", {},
        ...[["", "默认(只读)"], ["editable", "可编辑"], ["readonly", "只读"], ["hidden", "隐藏"]]
          .map(([v, l]) => h("option", { value: v, selected: (perm.access || "") === v }, l)));
      acc.addEventListener("change", () => {
        if (!acc.value) delete (node.fieldPermissions[f.name] = perm).access;
        else perm.access = acc.value;
        if (!acc.value && !perm.required) delete node.fieldPermissions[f.name];
      });
      const req = h("input", { type: "checkbox", checked: !!perm.required, disabled: (perm.access || "") !== "editable" });
      req.addEventListener("change", () => (perm.required = req.checked));
      acc.addEventListener("change", () => { req.disabled = (perm.access || "") !== "editable"; if (req.disabled) { req.checked = false; perm.required = false; } });
      tb.append(h("tr", {}, h("td", {}, f.label || f.name), h("td", {}, acc), h("td", {}, req)));
    }
    tbl.append(tb);
    box.append(tbl);
  };
  sel.addEventListener("change", () => { node.formRef = sel.value || undefined; if (!sel.value) delete node.fieldPermissions; renderPerms(); });
  renderPerms();
  return h("div", {}, h("h3", {}, "表单与字段权限"),
    h("div", { class: "field" }, h("label", {}, "绑定表单"), sel), box,
    h("div", { class: "hint", style: "margin-top:6px" }, "「节点 × 字段」矩阵：隐藏=不渲染，只读=灰化，可编辑=可填写。"));
}

function renderVariablesEditor(D, redraw) {
  const wrap = h("div", { class: "stack" });
  const list = (D.snap.variables ||= []);
  list.forEach((v, idx) => {
    const row = h("div", { class: "grid2", style: "grid-template-columns: 1.2fr 1fr auto auto" },
      h("input", { type: "text", value: v.name, placeholder: "变量名", on: { change: (e) => (v.name = e.target.value.trim()) } }),
      h("select", {}, ...[["string", "string"], ["number", "number"], ["amount", "amount"], ["bool", "bool"], ["date", "date"], ["json", "json"]]
        .map(([val, l]) => h("option", { value: val, selected: (v.type || "string") === val }, l))),
      h("label", { class: "check" }, h("input", {
        type: "checkbox", checked: !!v.required, on: { change: (e) => (v.required = e.target.checked) },
      }), "必填"),
      h("button", { class: "btn sm ghost", on: { click: () => { list.splice(idx, 1); drawPanel(D, document.querySelector(".panel"), redraw); } } }, "✕"),
    );
    row.querySelector("select").addEventListener("change", (e) => (v.type = e.target.value));
    wrap.append(row);
  });
  wrap.append(h("button", {
    class: "btn sm", on: { click: () => { list.push({ name: `var_${list.length + 1}`, type: "string" }); drawPanel(D, document.querySelector(".panel"), redraw); } },
  }, "＋ 变量"));
  return wrap;
}

async function saveDraft(D, redraw) {
  try {
    const r = await api(`/definitions/${D.key}/draft`, { method: "PUT", body: { snapshot: D.snap, rev: D.rev } });
    D.rev = r.rev;
    toast("草稿已保存");
    if ((r.issues || []).some((i) => i.level === "error")) showIssues(r.issues);
    redraw();
  } catch (e) { toast(e.message, true); }
}

async function validateDraft(D) {
  const r = await api(`/definitions/${D.key}/validate`, { method: "POST", body: { snapshot: D.snap } });
  showIssues(r.issues || []);
}

async function submitDraft(D) {
  if (!confirm("提交发布？会生成一个不可变版本，等管理员发布。")) return;
  await saveDraft(D, () => {});
  try {
    const v = await api(`/definitions/${D.key}/submit`, { method: "POST" });
    toast(`已提交 v${v.version}，等管理员发布`);
  } catch (e) {
    if (e.code === "VALIDATION_FAILED") showIssues(e.details.issues || []);
    else toast(e.message, true);
  }
}

function jsonDialog(D, redraw) {
  const ta = h("textarea", { class: "mono", style: "min-height:420px;width:100%" });
  ta.value = JSON.stringify(D.snap, null, 2);
  const body = h("div", {}, h("div", { class: "hint" }, "设计器与 JSON 双向；改完点应用。"), ta);
  const apply = h("button", {
    class: "btn primary",
    on: {
      click: () => {
        try {
          D.snap = JSON.parse(ta.value);
          closeModal();
          D.selected = null;
          redraw();
          toast("已应用到草稿（记得保存）");
        } catch (e) { toast("JSON 解析失败：" + e.message, true); }
      },
    },
  }, "应用");
  openModal("流程 JSON", body, [h("button", { class: "btn", on: { click: closeModal } }, "取消"), apply]);
}

function dryRunDialog(D) {
  const defaults = {};
  for (const v of D.snap.variables || []) if (v.default !== undefined) defaults[v.name] = v.default;
  const ta = h("textarea", { class: "mono", style: "min-height:120px;width:100%" });
  ta.value = JSON.stringify(defaults, null, 2);
  const out = h("div", { class: "issues" });
  const run = h("button", {
    class: "btn primary",
    on: {
      click: async () => {
        clear(out);
        try {
          const vars = JSON.parse(ta.value || "{}");
          const r = await api(`/definitions/${D.key}/dry-run`, { method: "POST", body: { variables: vars } });
          out.append(h("div", { class: "issue" }, `结果：${r.status}${r.outcome ? " · " + r.outcome : ""} · 人工步骤 ${r.steps}`));
          const tl = h("ol", { style: "margin:6px 0 0 18px;padding:0" });
          for (const t of r.trace) {
            tl.append(h("li", {}, `${t.nodeName}（${nodeTag(t.nodeType)}）${t.status}` +
              (t.error ? " · " + t.error : "") + (t.result && Object.keys(t.result).length ? " · " + JSON.stringify(t.result) : "")));
          }
          out.append(tl);
          out.append(h("div", { class: "issue" }, "变量：" + JSON.stringify(r.variables)));
        } catch (e) { toast(e.message, true); }
      },
    },
  }, "试跑");
  openModal("试跑（不落库）", h("div", { class: "stack" }, h("div", { class: "hint" }, "输入变量 JSON；人工节点会自动按「同意」处理。"), ta, out), [run, h("button", { class: "btn", on: { click: closeModal } }, "关闭")]);
}

// ----------------------------------------------------------------- 表单列表/编辑

async function viewForms() {
  const data = await api("/forms");
  const isAdmin = (state.me?.roles || []).includes("admin");
  view.append(h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "表单"), h("div", { class: "sub" }, "表单是独立可复用资产；流程节点通过 formRef 绑定它，并配字段权限。"))));
  const card = h("div", { class: "card" });
  const table = h("table", {}, h("thead", {}, h("tr", {}, ["KEY", "名称", "已发布", "字段", "操作"].map((x) => h("th", {}, x)))));
  const tb = h("tbody");
  for (const f of data.items) {
    tb.append(h("tr", {},
      h("td", { class: "mono" }, f.key),
      h("td", {}, f.name),
      h("td", {}, f.published ? `v${f.published.version}` : h("span", { class: "tag amber" }, "未发布")),
      h("td", {}, (f.published?.schema?.fields || []).length + " 个"),
      h("td", {}, h("div", { class: "row" },
        h("button", { class: "btn sm", on: { click: () => editFormDialog(f) } }, "编辑"),
        isAdmin ? h("button", { class: "btn sm", on: { click: () => publishForm(f.key) } }, "发布") : null)),
    ));
  }
  table.append(tb); card.append(table); view.append(card);
}

function editFormDialog(f) {
  const ta = h("textarea", { class: "mono", style: "min-height:380px;width:100%" });
  ta.value = JSON.stringify(f.draftSchema, null, 2);
  const save = h("button", {
    class: "btn primary",
    on: {
      click: async () => {
        try {
          const schema = JSON.parse(ta.value);
          await api(`/forms/${f.key}/draft`, { method: "PUT", body: { schema, rev: f.draftRev } });
          closeModal(); toast("表单草稿已保存"); render();
        } catch (e) { toast(e.message, true); }
      },
    },
  }, "保存草稿");
  openModal(`表单 ${f.key}`, h("div", { class: "stack" }, h("div", { class: "hint" }, "MVP 用 JSON 编辑字段（可视化拖拽设计器见技术方案 §11）。"), ta), [h("button", { class: "btn", on: { click: closeModal } }, "取消"), save]);
}

async function publishForm(key) {
  if (!confirm(`发布表单 ${key} 的草稿？已绑定旧版本的流程不受影响。`)) return;
  try { const r = await api(`/forms/${key}/publish`, { method: "POST" }); toast(`已发布 v${r.version}`); render(); }
  catch (e) { toast(e.message, true); }
}

// ----------------------------------------------------------------- 待办

async function viewTasks() {
  const tab = sessionStorage.getItem("pw_task_tab") || "pending";
  const data = await api(`/tasks?assignee=me&status=${tab}`);
  view.append(h("div", { class: "page-head" },
    h("div", {}, h("h1", {}, "我的待办"), h("div", { class: "sub" }, "同意 / 否决 / 退回 / 转交 / 加签都在任务详情里。")),
    h("div", { class: "pill-row" },
      h("button", { class: "btn sm" + (tab === "pending" ? " primary" : ""), on: { click: () => { sessionStorage.setItem("pw_task_tab", "pending"); render(); } } }, "待办"),
      h("button", { class: "btn sm" + (tab === "done" ? " primary" : ""), on: { click: () => { sessionStorage.setItem("pw_task_tab", "done"); render(); } } }, "已办"),
    )));
  const card = h("div", { class: "card" });
  const table = h("table", {}, h("thead", {}, h("tr", {}, ["标题", "节点", "业务单号", "状态", "时间", ""].map((x) => h("th", {}, x)))));
  const tb = h("tbody");
  for (const t of data.items) {
    tb.append(h("tr", {},
      h("td", {}, t.title || t.definitionKey || "—"),
      h("td", {}, t.nodeName, h("div", { class: "hint" }, t.kind === "resubmit" ? "重提单" : t.kind)),
      h("td", { class: "mono" }, t.businessKey || "—"),
      h("td", {}, h("span", { class: "tag " + (t.status === "CREATED" ? "amber" : t.status === "CLAIMED" ? "blue" : "green") }, t.status)),
      h("td", { class: "small muted" }, fmtTime(t.createdAt)),
      h("td", {}, h("a", { class: "btn sm", href: `#/task/${t.id}` }, "打开")),
    ));
  }
  if (!data.items.length) tb.append(h("tr", {}, h("td", { colspan: 6, class: "empty" }, tab === "pending" ? "没有待办" : "还没有处理过的任务")));
  table.append(tb); card.append(table); view.append(card);
}

async function viewTask(id) {
  const data = await api(`/tasks/${id}/form`);
  const { form, nodeName, signMode, instance, task } = data;
  view.append(h("div", { class: "page-head" },
    h("div", {}, h("h1", {}, nodeName || `任务 ${id}`), h("div", { class: "sub" }, `${instance.title || ""} · ${instance.businessKey} · ${({ any: "或签", all: "并签", race: "竞签", first: "表单填写" }[signMode] || signMode)}`)),
    h("a", { class: "btn", href: "#/tasks" }, "← 返回待办")));

  const card = h("div", { class: "card" });
  const body = h("div", { class: "card-body stack" });
  const collected = {};
  if (form) {
    for (const f of form.fields) {
      if (f.type === "static") { body.append(h("p", { class: "hint" }, f.text)); continue; }
      collected[f.name] = f.value;
      body.append(renderField(f, collected));
    }
  } else {
    body.append(h("p", { class: "hint" }, "这个节点没有绑定表单，直接给出审批结论即可。"));
  }
  const comment = h("textarea", { placeholder: "审批意见（可选）", style: "min-height:70px" });
  body.append(h("div", { class: "field" }, h("label", {}, "审批意见"), comment));
  card.append(body);

  const foot = h("div", { class: "card-body row", style: "border-top:1px solid var(--line)" });
  const isApproval = data.nodeType === "approval";
  const submit = async (verdict) => {
    const editable = {};
    if (form) for (const f of form.fields) if (f.access === "editable" && f.name) editable[f.name] = collected[f.name];
    try {
      if (isApproval) {
        if (form) await api(`/tasks/${id}/submit-form`, { method: "POST", body: { verdict, comment: comment.value, data: editable } });
        else await api(`/tasks/${id}/complete`, { method: "POST", body: { verdict, comment: comment.value } });
      } else {
        await api(`/tasks/${id}/submit-form`, { method: "POST", body: { comment: comment.value, data: editable } });
      }
      toast("已提交");
      location.hash = "#/tasks";
    } catch (e) {
      if (e.code === "FORM_VALIDATION_FAILED") {
        const errs = (e.details.errors || []).map((x) => `${x.field}：${x.message}`).join("\n");
        toast(errs || e.message, true);
      } else toast(e.message, true);
    }
  };
  if (isApproval) {
    foot.append(h("button", { class: "btn primary", on: { click: () => submit("approve") } }, "同意"));
    foot.append(h("button", { class: "btn danger", on: { click: () => submit("reject") } }, "否决"));
  } else {
    foot.append(h("button", { class: "btn primary", on: { click: () => submit("submit") } }, task.kind === "resubmit" ? "重新提交" : "提交"));
  }
  foot.append(h("span", { class: "grow" }));
  foot.append(h("button", { class: "btn sm", on: { click: () => delegateDialog(id) } }, "转交"));
  foot.append(h("button", { class: "btn sm", on: { click: () => addSignDialog(id) } }, "加签"));
  card.append(foot);
  view.append(card);
  view.append(h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "实例")),
    h("div", { class: "card-body" }, h("a", { href: `#/instance/${instance.id}` }, `#${instance.id} ${instance.title || ""}`), " ", statusTag(instance.status))));
}

function renderField(f, collected) {
  const disabled = f.access !== "editable";
  const set = (v) => { collected[f.name] = v; };
  let input;
  switch (f.type) {
    case "textarea":
      input = h("textarea", { disabled, value: f.value ?? "" }); input.addEventListener("input", () => set(input.value)); break;
    case "number": case "amount": case "rating":
      input = h("input", { type: "number", disabled, value: f.value ?? "", ...(f.min !== undefined && f.min !== null ? { min: f.min } : {}), ...(f.max !== undefined && f.max !== null ? { max: f.max } : {}) });
      input.addEventListener("input", () => set(input.value === "" ? null : Number(input.value))); break;
    case "date":
      input = h("input", { type: "date", disabled, value: f.value ?? "" }); input.addEventListener("change", () => set(input.value)); break;
    case "datetime":
      input = h("input", { type: "datetime-local", disabled, value: String(f.value ?? "").slice(0, 16) }); input.addEventListener("change", () => set(input.value)); break;
    case "switch": {
      const cb = h("input", { type: "checkbox", disabled, checked: !!f.value });
      cb.addEventListener("change", () => set(cb.checked));
      input = h("label", { class: "check" }, cb, f.value ? "是" : "否"); break;
    }
    case "select":
      input = h("select", { disabled },
        h("option", { value: "" }, "请选择"),
        ...(f.options || []).map((o) => h("option", { value: o.value, selected: String(f.value) === String(o.value) }, o.label)));
      input.addEventListener("change", () => set(input.value || null)); break;
    case "multi_select": {
      const box = h("div", { class: "pill-row" });
      const chosen = new Set(Array.isArray(f.value) ? f.value : []);
      for (const o of f.options || []) {
        const cb = h("input", { type: "checkbox", disabled, checked: chosen.has(o.value) });
        cb.addEventListener("change", () => { cb.checked ? chosen.add(o.value) : chosen.delete(o.value); set([...chosen]); });
        box.append(h("label", { class: "check" }, cb, o.label));
      }
      input = box; break;
    }
    default:
      input = h("input", { type: "text", disabled, value: f.value ?? "", ...(f.max_length ? { maxlength: f.max_length } : {}) });
      input.addEventListener("input", () => set(input.value));
  }
  return h("div", { class: "field" },
    h("label", {}, f.label, f.required ? h("span", { style: "color:var(--red)" }, " *") : null,
      f.access === "readonly" ? h("span", { class: "tag", style: "margin-left:6px" }, "只读") : null),
    input);
}

function delegateDialog(taskId) {
  const sel = h("select", {}, ...state.users.filter((u) => u.id !== state.me.id).map((u) => h("option", { value: u.id }, `${u.name}（${u.id}）`)));
  const body = h("div", { class: "field" }, h("label", {}, "转交给"), sel);
  openModal("转交任务", body, [
    h("button", { class: "btn", on: { click: closeModal } }, "取消"),
    h("button", {
      class: "btn primary",
      on: {
        click: async () => {
          try { await api(`/tasks/${taskId}/delegate`, { method: "POST", body: { to: sel.value } }); closeModal(); toast("已转交"); location.hash = "#/tasks"; }
          catch (e) { toast(e.message, true); }
        },
      },
    }, "转交"),
  ]);
}

function addSignDialog(taskId) {
  const box = h("div", { class: "pill-row" });
  const chosen = new Set();
  for (const u of state.users.filter((x) => x.id !== state.me.id)) {
    const cb = h("input", { type: "checkbox" });
    cb.addEventListener("change", () => { cb.checked ? chosen.add(u.id) : chosen.delete(u.id); });
    box.append(h("label", { class: "check" }, cb, `${u.name}（${u.id}）`));
  }
  openModal("加签", h("div", { class: "stack" }, h("div", { class: "hint" }, "加签产生的任务纳入本节点同一裁决集合。"), box), [
    h("button", { class: "btn", on: { click: closeModal } }, "取消"),
    h("button", {
      class: "btn primary",
      on: {
        click: async () => {
          try { const r = await api(`/tasks/${taskId}/add-sign`, { method: "POST", body: { users: [...chosen] } }); closeModal(); toast(`已加签 ${r.added.length} 人`); }
          catch (e) { toast(e.message, true); }
        },
      },
    }, "确定"),
  ]);
}

// ----------------------------------------------------------------- 实例

async function viewInstances() {
  const status = sessionStorage.getItem("pw_inst_status") || "";
  const data = await api("/instances" + (status ? `?status=${status}` : ""));
  const isAdmin = (state.me?.roles || []).includes("admin");
  view.append(h("div", { class: "page-head" },
    h("div", {}, h("h1", {}, isAdmin ? "实例（全部）" : "我的实例"), h("div", { class: "sub" }, "点开看时间线与当前卡点；管理员可在这里干预。")),
    h("select", {
      style: "width:auto",
      on: { change: (e) => { sessionStorage.setItem("pw_inst_status", e.target.value); render(); } },
    }, ...["", "RUNNING", "COMPLETED", "TERMINATED", "FAILED", "SUSPENDED"].map((s) => h("option", { value: s, selected: s === status }, s || "全部状态"))),
  ));
  const card = h("div", { class: "card" });
  const table = h("table", {}, h("thead", {}, h("tr", {}, ["#", "标题", "流程", "业务单号", "发起人", "状态", "创建时间", ""].map((x) => h("th", {}, x)))));
  const tb = h("tbody");
  for (const i of data.items) {
    tb.append(h("tr", {},
      h("td", { class: "mono" }, "#" + i.id),
      h("td", {}, i.title || "—"),
      h("td", {}, i.definitionName, h("div", { class: "hint" }, `v${i.version}`)),
      h("td", { class: "mono" }, i.businessKey),
      h("td", {}, i.initiatorName),
      h("td", {}, statusTag(i.status, i.outcome)),
      h("td", { class: "small muted" }, fmtTime(i.createdAt)),
      h("td", {}, h("a", { class: "btn sm", href: `#/instance/${i.id}` }, "打开")),
    ));
  }
  if (!data.items.length) tb.append(h("tr", {}, h("td", { colspan: 8, class: "empty" }, "没有实例")));
  table.append(tb); card.append(table); view.append(card);
}

async function viewInstance(id) {
  const i = await api(`/instances/${id}`);
  const isAdmin = (state.me?.roles || []).includes("admin");
  view.append(h("div", { class: "page-head" },
    h("div", {}, h("h1", {}, i.title || `实例 #${i.id}`), h("div", { class: "sub" }, `${i.definitionName} · ${i.definitionKey} v${i.version} · ${i.businessKey}`)),
    h("div", { class: "row" }, statusTag(i.status, i.outcome), h("a", { class: "btn", href: "#/instances" }, "← 返回"))));

  const summary = h("div", { class: "card" }, h("div", { class: "card-body" },
    h("div", { class: "grid2" },
      h("dl", { class: "kv" },
        h("dt", {}, "发起人"), h("dd", {}, i.initiatorName),
        h("dt", {}, "创建"), h("dd", {}, fmtTime(i.createdAt)),
        h("dt", {}, "结束"), h("dd", {}, fmtTime(i.endedAt))),
      h("dl", { class: "kv" },
        h("dt", {}, "当前节点"), h("dd", {}, i.currentNodes.length ? i.currentNodes.map((n) => `${n.nodeName}（${n.assignees.join("、") || "—"}）`).join("；") : "—"),
        h("dt", {}, "待办"), h("dd", {}, i.openTasks.length + " 个"),
        h("dt", {}, "结论"), h("dd", {}, i.outcome || "—"))),
  ));
  view.append(summary);

  if (i.openTasks.length) {
    const tcard = h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "在途任务")));
    const tb = h("tbody");
    for (const t of i.openTasks) {
      const row = h("tr", {}, h("td", {}, t.nodeName), h("td", {}, t.assigneeName), h("td", {}, t.status),
        h("td", {}, h("a", { class: "btn sm", href: `#/task/${t.id}` }, "打开")));
      if (isAdmin) {
        row.append(h("td", {}, h("div", { class: "row" },
          h("button", { class: "btn sm", on: { click: () => forceDialog(t.id, "approve") } }, "代批通过"),
          h("button", { class: "btn sm danger", on: { click: () => forceDialog(t.id, "reject") } }, "代批否决"))));
      }
      tb.append(row);
    }
    tcard.append(h("table", {}, h("thead", {}, h("tr", {}, ["节点", "处理人", "状态", "", isAdmin ? "管理员" : ""].map((x) => h("th", {}, x)))), tb));
    view.append(tcard);
  }

  view.append(h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "上下文变量")),
    h("div", { class: "card-body" }, h("table", {}, h("tbody", {},
      ...Object.entries(i.variables || {}).map(([k, v]) => h("tr", {}, h("td", { class: "mono" }, k), h("td", {}, fmtVal(v))))),
      ...(Object.keys(i.variables || {}).length ? [] : [h("tr", {}, h("td", { class: "empty" }, "没有变量"))])))));

  const ncard = h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "节点执行记录")),
    h("div", { class: "card-body" }, h("table", {},
      h("thead", {}, h("tr", {}, ["节点", "类型", "状态", "第几次", "结果/错误"].map((x) => h("th", {}, x)))),
      h("tbody", {}, ...(i.nodeInstances || []).map((n) => h("tr", {},
        h("td", {}, n.nodeName), h("td", {}, nodeTag(n.nodeType)), h("td", {}, n.status), h("td", {}, n.activationSeq),
        h("td", { class: "mono" }, n.error || (n.result ? JSON.stringify(n.result) : "—"))))))));
  view.append(ncard);

  const tl = h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "时间线（审计 + 变量 + 任务）")));
  const tbody = h("div", { class: "card-body" });
  const list = h("ul", { class: "timeline" });
  for (const it of [...(i.timeline || [])].reverse()) {
    list.append(h("li", { class: it.kind },
      h("div", {}, h("strong", {}, it.action), " ", h("span", { class: "muted small" }, it.actor || "")),
      h("div", { class: "t" }, fmtTime(it.at)),
      it.detail && Object.keys(it.detail).length ? h("div", { class: "mono muted" }, JSON.stringify(it.detail).slice(0, 300)) : null));
  }
  tbody.append(list);
  tl.append(tbody);
  view.append(tl);

  if (isAdmin) {
    const actions = h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "管理员干预")),
      h("div", { class: "card-body row" },
        h("button", { class: "btn sm", on: { click: () => adminAct(id, "suspend") } }, "挂起"),
        h("button", { class: "btn sm", on: { click: () => adminAct(id, "resume") } }, "恢复"),
        h("button", { class: "btn sm", on: { click: () => adminAct(id, "retry") } }, "重试失败节点"),
        h("button", { class: "btn sm", on: { click: () => setVarDialog(id) } }, "改变量"),
        h("button", { class: "btn sm danger", on: { click: () => adminAct(id, "terminate") } }, "终止")));
    view.append(actions);
  }
}

async function adminAct(id, action) {
  if (action === "terminate" && !confirm("终止这个实例？在途任务会被回收。")) return;
  try {
    const body = action === "terminate" ? { reason: "管理员终止" } : {};
    await api(`/instances/${id}/${action}`, { method: "POST", body });
    toast("已执行");
    render();
  } catch (e) { toast(e.message, true); }
}

function forceDialog(taskId, verdict) {
  const comment = h("input", { type: "text", placeholder: "原因（会写审计）" });
  openModal("管理员代批", h("div", { class: "field" }, h("label", {}, "操作原因"), comment), [
    h("button", { class: "btn", on: { click: closeModal } }, "取消"),
    h("button", {
      class: "btn primary",
      on: {
        click: async () => {
          try { await api(`/admin/tasks/${taskId}/force-complete`, { method: "POST", body: { verdict, comment: comment.value } }); closeModal(); toast("已代批"); render(); }
          catch (e) { toast(e.message, true); }
        },
      },
    }, "确定"),
  ]);
}

function setVarDialog(instanceId) {
  const name = h("input", { type: "text", placeholder: "变量名" });
  const value = h("input", { type: "text", placeholder: "JSON 或字符串" });
  openModal("修改变量", h("div", { class: "stack" },
    h("div", { class: "field" }, h("label", {}, "变量名"), name),
    h("div", { class: "field" }, h("label", {}, "新值"), value),
    h("div", { class: "hint" }, "危险操作：会写审计，按 last-write-wins 覆盖。")), [
    h("button", { class: "btn", on: { click: closeModal } }, "取消"),
    h("button", {
      class: "btn primary",
      on: {
        click: async () => {
          let v;
          try { v = JSON.parse(value.value); } catch { v = value.value; }
          try { await api(`/admin/instances/${instanceId}/set-variable`, { method: "POST", body: { name: name.value.trim(), value: v } }); closeModal(); toast("已修改"); render(); }
          catch (e) { toast(e.message, true); }
        },
      },
    }, "确定"),
  ]);
}

// ----------------------------------------------------------------- 发起流程

async function viewStart(key) {
  const def = await api(`/definitions/${key}`);
  if (!def.currentVersion) { view.append(h("div", { class: "card empty" }, "该流程还没有已发布版本")); return; }
  const versionData = await api(`/definitions/${key}/versions/${def.currentVersion}`);
  const snap = versionData.snapshot;
  const startNode = (snap.nodes || []).find((n) => n.type === "start");
  const formsData = await api("/forms");
  const schemas = {};
  for (const f of formsData.items) if (f.published) schemas[f.key] = f.published.schema;

  const collected = {};
  const fieldsBox = h("div", { class: "stack" });
  if (startNode?.formRef && schemas[startNode.formRef]) {
    const schema = schemas[startNode.formRef];
    const perms = startNode.fieldPermissions || {};
    for (const f of schema.fields) {
      if (f.type === "static") continue;
      const perm = perms[f.name] || { access: "readonly" };
      if (perm.access === "hidden") continue;
      const fake = { ...f, access: perm.access, required: perm.required && perm.access === "editable", value: f.default ?? null };
      collected[f.name] = fake.value;
      fieldsBox.append(renderField(fake, collected));
    }
  } else {
    fieldsBox.append(h("p", { class: "hint" }, "这个流程的发起节点没有绑定表单；请直接填写变量。"));
    for (const v of snap.variables || []) {
      const input = h("input", { type: v.type === "number" || v.type === "amount" ? "number" : "text" });
      input.addEventListener("input", () => (collected[v.name] = v.type === "number" ? Number(input.value) : input.value));
      fieldsBox.append(h("div", { class: "field" }, h("label", {}, `${v.name}${v.required ? " *" : ""}（${v.type}）`), input));
    }
  }

  const bk = h("input", { type: "text", placeholder: "业务单号（唯一，用于幂等与反查）" });
  const title = h("input", { type: "text", placeholder: "标题（待办列表展示）" });
  const body = h("div", { class: "card-body stack" },
    h("div", { class: "grid2" },
      h("div", { class: "field" }, h("label", {}, "业务单号 *"), bk),
      h("div", { class: "field" }, h("label", {}, "标题"), title)),
    h("div", { class: "section", style: "border-top:1px dashed var(--line);padding-top:12px" }, fieldsBox),
  );
  const submit = h("button", {
    class: "btn primary",
    on: {
      click: async () => {
        try {
          const variables = {};
          const schemaKey = startNode?.formRef;
          const schema = schemaKey ? schemas[schemaKey] : null;
          if (schema) {
            const perms = startNode.fieldPermissions || {};
            for (const f of schema.fields) if (f.type !== "static" && (perms[f.name]?.access || "readonly") === "editable" && collected[f.name] !== undefined) variables[f.name] = collected[f.name];
          } else {
            Object.assign(variables, collected);
          }
          const inst = await api("/instances", { method: "POST", body: { key, businessKey: bk.value.trim(), title: title.value.trim(), variables }, headers: { "Idempotency-Key": bk.value.trim() } });
          toast("已发起");
          location.hash = `#/instance/${inst.id}`;
        } catch (e) { toast(e.message, true); }
      },
    },
  }, "发起流程");

  view.append(h("div", { class: "page-head" },
    h("div", {}, h("h1", {}, `发起：${def.name}`), h("div", { class: "sub" }, `${key} · 使用当前版本 v${def.currentVersion}`)),
    h("a", { class: "btn", href: "#/definitions" }, "← 返回")));
  view.append(h("div", { class: "card" }, body, h("div", { class: "card-body row", style: "border-top:1px solid var(--line)" }, submit)));
}

// ----------------------------------------------------------------- 运维

async function viewAdmin() {
  const [stats, outbox, hooks, sink] = await Promise.all([
    api("/admin/stats"), api("/admin/outbox?limit=30"), api("/admin/webhooks"), api("/admin/dev-sink?limit=20"),
  ]);
  view.append(h("div", { class: "page-head" }, h("div", {}, h("h1", {}, "运维"), h("div", { class: "sub" }, "状态分布 / 待办积压 / 事件投递 / 回调接收。"))));
  const cardsRow = h("div", { class: "grid2" });
  const statusText = Object.entries(stats.instancesByStatus || {}).map(([k, v]) => `${k}=${v}`).join("  ") || "无实例";
  cardsRow.append(statCard("实例状态", statusText), statCard("在途任务 / 待投事件 / 死信", `${stats.openTasks} / ${stats.outboxPending} / ${stats.outboxDead}`));
  view.append(h("div", { class: "card" }, h("div", { class: "card-body" }, cardsRow)));

  if ((stats.failedInstances || []).length) {
    view.append(h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "失败实例")),
      h("div", { class: "card-body" }, h("table", {}, h("tbody", {}, ...stats.failedInstances.map((i) =>
        h("tr", {}, h("td", { class: "mono" }, "#" + i.id), h("td", {}, i.title || "—"), h("td", {}, i.definitionKey),
          h("td", {}, h("a", { href: `#/instance/${i.id}` }, "打开")))))))));
  }

  const ob = h("tbody");
  for (const e of outbox.items) {
    ob.append(h("tr", {}, h("td", { class: "mono" }, e.id), h("td", {}, e.type), h("td", {}, h("span", { class: "tag " + (e.status === "DELIVERED" ? "green" : e.status === "DEAD" ? "red" : "amber") }, e.status)),
      h("td", {}, e.attempts), h("td", { class: "small muted" }, fmtTime(e.createdAt))));
  }
  view.append(h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "事件 Outbox")),
    h("div", { class: "card-body" }, h("table", {}, h("thead", {}, h("tr", {}, ["ID", "类型", "状态", "尝试", "时间"].map((x) => h("th", {}, x)))), ob))));

  const hookRows = h("tbody", {}, ...hooks.items.map((w) => h("tr", {}, h("td", {}, w.url), h("td", {}, w.definitionKey || "（全局）"), h("td", {}, w.secret ? "已签名" : "无签名"),
    h("td", {}, h("button", { class: "btn sm danger", on: { click: async () => { await api(`/admin/webhooks/${w.id}`, { method: "DELETE" }); render(); } } }, "删除")))));
  const urlInput = h("input", { type: "text", placeholder: "https://example.com/hook" });
  const secretInput = h("input", { type: "text", placeholder: "密钥（可选，用于 HMAC 签名）" });
  view.append(h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "Webhook 订阅")),
    h("div", { class: "card-body stack" },
      h("table", {}, h("thead", {}, h("tr", {}, ["URL", "范围", "签名", ""].map((x) => h("th", {}, x)))), hookRows),
      h("div", { class: "row" }, urlInput, secretInput,
        h("button", {
          class: "btn sm primary",
          on: {
            click: async () => {
              try { await api("/admin/webhooks", { method: "POST", body: { url: urlInput.value.trim(), secret: secretInput.value.trim() } }); render(); }
              catch (e) { toast(e.message, true); }
            },
          },
        }, "添加")))));

  const sinkRows = h("tbody", {}, ...sink.items.map((e) => h("tr", {}, h("td", { class: "mono" }, e.id), h("td", {}, e.eventType),
    h("td", { class: "mono small" }, JSON.stringify(e.payload).slice(0, 160)), h("td", { class: "small muted" }, fmtTime(e.receivedAt)))));
  view.append(h("div", { class: "card" }, h("div", { class: "card-head" }, h("h2", {}, "演示回调接收器（最近 20 条）")),
    h("div", { class: "card-body" }, h("table", {}, h("thead", {}, h("tr", {}, ["ID", "事件", "载荷", "时间"].map((x) => h("th", {}, x)))), sinkRows))));
}

function statCard(label, value) {
  return h("div", {}, h("div", { class: "hint" }, label), h("div", { style: "font-size:15px;font-weight:600;margin-top:4px" }, value));
}

// ----------------------------------------------------------------- 启动

async function boot() {
  document.getElementById("modal-close").addEventListener("click", closeModal);
  document.getElementById("modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

  const users = await (await fetch(API + "/dev/demo-users")).json();
  state.users = users.items;
  const sel = document.getElementById("user-switch");
  for (const u of state.users) sel.append(h("option", { value: u.token }, `${u.name}（${u.roles.join("/")}）`));
  sel.value = state.token;
  if (!state.users.some((u) => u.token === state.token)) sel.value = state.users[0].token;
  state.token = sel.value;
  sel.addEventListener("change", async () => {
    state.token = sel.value;
    localStorage.setItem("pw_token", state.token);
    await loadMe();
    render();
  });
  await loadMe();
  window.addEventListener("hashchange", render);
  render();
}

async function loadMe() {
  try {
    state.me = await api("/me");
    document.getElementById("role-hint").textContent = `${state.me.name} · ${state.me.roles.join("/")}`;
    const admin = state.me.roles.includes("admin");
    document.getElementById("nav-admin").style.display = admin ? "" : "none";
  } catch (e) {
    toast(e.message, true);
  }
}

boot();
