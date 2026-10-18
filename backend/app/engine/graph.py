"""流程快照的读取、自动布局与发布前校验（PRD §5.2 / §5.5）。

快照是**唯一权威**：实例运行期只读 `wf_version.snapshot_json`；表单绑定
（`formRef + fieldPermissions`）也在快照节点上，发布时物化到 wf_form_binding 供查询。
"""

from __future__ import annotations

from collections import defaultdict, deque

from ..config import settings
from .expr import ExprError, expr_names, validate_expr

# MVP 支持的节点类型；其余类型在这里显式拒绝，避免"配了但不生效"
SUPPORTED_NODE_TYPES = {
    "start",
    "end",
    "approval",
    "form",
    "script",
    "exclusive_gateway",
    "parallel_gateway",
}

KNOWN_NODE_TYPES = SUPPORTED_NODE_TYPES | {
    "cc",
    "service",
    "inclusive_gateway",
    "timer",
    "wait",
    "sub_process",
    "plugin",
}

SIGN_MODES = {"any", "all", "race"}
REJECT_STRATEGIES = {"to_start", "terminate"}
EMPTY_ASSIGNEE_POLICIES = {"admins", "auto_approve", "fail"}


class Snapshot:
    def __init__(self, data: dict) -> None:
        self.data = data or {}
        self.key: str = self.data.get("key") or ""
        self.name: str = self.data.get("name") or ""
        self.variables: list[dict] = list(self.data.get("variables") or [])
        self.nodes: list[dict] = list(self.data.get("nodes") or [])
        self.edges: list[dict] = list(self.data.get("edges") or [])
        self.node_map: dict[str, dict] = {n.get("id"): n for n in self.nodes if n.get("id")}
        self.edge_map: dict[str, dict] = {e.get("id"): e for e in self.edges if e.get("id")}
        self.out_edges: dict[str, list[dict]] = defaultdict(list)
        self.in_edges: dict[str, list[dict]] = defaultdict(list)
        for e in self.edges:
            self.out_edges[e.get("from")].append(e)
            self.in_edges[e.get("to")].append(e)
        self.variable_names = {v.get("name") for v in self.variables if v.get("name")}

    def node(self, node_id: str) -> dict | None:
        return self.node_map.get(node_id)

    def start_node(self) -> dict | None:
        for n in self.nodes:
            if n.get("type") == "start":
                return n
        return None

    def var_decl(self, name: str) -> dict | None:
        for v in self.variables:
            if v.get("name") == name:
                return v
        return None

    def gateway_direction(self, node: dict) -> str:
        """fork / join：显式配置优先，否则按入出边数推断。"""
        direction = (node.get("gatewayDirection") or "").strip()
        if direction in ("fork", "join"):
            return direction
        ins = len(self.in_edges.get(node["id"], []))
        outs = len(self.out_edges.get(node["id"], []))
        if ins <= 1 and outs >= 1:
            return "fork"
        if ins >= 1 and outs == 1:
            return "join"
        return "unknown"


def issue(level: str, code: str, message: str, node: str | None = None, edge: str | None = None) -> dict:
    return {"level": level, "code": code, "message": message, "node": node, "edge": edge}


def validate_snapshot(data: dict, form_schemas: dict[str, dict] | None = None) -> list[dict]:
    """返回问题列表。任何 `level=error` 都阻断发布（PRD §5.5）。"""
    form_schemas = form_schemas or {}
    issues: list[dict] = []
    if not isinstance(data, dict) or not data:
        return [issue("error", "E_EMPTY", "流程定义不能为空")]

    key = data.get("key")
    if not key:
        issues.append(issue("error", "E_KEY", "缺少 key"))
    nodes = data.get("nodes") or []
    edges = data.get("edges") or []
    if not nodes:
        return issues + [issue("error", "E_NO_NODES", "流程至少要有一个节点")]

    # ---- 基础结构
    seen_nodes = set()
    for n in nodes:
        nid = n.get("id")
        if not nid:
            issues.append(issue("error", "E_NODE_ID", "节点缺少 id"))
            continue
        if nid in seen_nodes:
            issues.append(issue("error", "E_DUP_NODE", f"节点 id 重复：{nid}", node=nid))
        seen_nodes.add(nid)
        ntype = n.get("type")
        if ntype not in KNOWN_NODE_TYPES:
            issues.append(issue("error", "E_NODE_TYPE", f"未知节点类型：{ntype}", node=nid))
        elif ntype not in SUPPORTED_NODE_TYPES:
            issues.append(
                issue("error", "E_NODE_TYPE_UNSUPPORTED", f"节点类型 {ntype} 属 P1/P2，本期不支持", node=nid)
            )

    seen_edges = set()
    for e in edges:
        eid = e.get("id")
        if not eid:
            issues.append(issue("error", "E_EDGE_ID", "边缺少 id"))
            continue
        if eid in seen_edges:
            issues.append(issue("error", "E_DUP_EDGE", f"边 id 重复：{eid}", edge=eid))
        seen_edges.add(eid)
        if e.get("from") not in seen_nodes:
            issues.append(issue("error", "E_EDGE_REF", f"边 {eid} 的起点节点不存在：{e.get('from')}", edge=eid))
        if e.get("to") not in seen_nodes:
            issues.append(issue("error", "E_EDGE_REF", f"边 {eid} 的终点节点不存在：{e.get('to')}", edge=eid))

    snap = Snapshot(data)
    starts = [n for n in snap.nodes if n.get("type") == "start"]
    if len(starts) != 1:
        issues.append(issue("error", "E_START_COUNT", f"必须有且仅有一个 start 节点（当前 {len(starts)} 个）"))
    ends = [n for n in snap.nodes if n.get("type") == "end"]
    if not ends:
        issues.append(issue("error", "E_END_MISSING", "至少需要一个 end 节点"))

    # ---- 出入边
    for n in snap.nodes:
        nid = n.get("id")
        ntype = n.get("type")
        ins = snap.in_edges.get(nid, [])
        outs = snap.out_edges.get(nid, [])
        if ntype == "start":
            if ins:
                issues.append(issue("error", "E_START_IN", "start 节点不能有入边", node=nid))
            if len(outs) != 1:
                issues.append(issue("error", "E_START_OUT", "start 节点必须且只能有一条出边", node=nid))
        elif ntype == "end":
            if not ins:
                issues.append(issue("error", "E_END_IN", "end 节点必须有入边", node=nid))
            if outs:
                issues.append(issue("error", "E_END_OUT", "end 节点不能有出边", node=nid))
        else:
            if not ins:
                issues.append(issue("error", "E_NO_IN", "节点没有入边（start 除外）", node=nid))
            if not outs:
                issues.append(issue("error", "E_NO_OUT", "节点没有出边（end 除外）", node=nid))

    # ---- 可达性（从 start 顺边、无视条件）与"能否到 end"
    if len(starts) == 1:
        reachable = _reachable(snap, starts[0]["id"])
        for n in snap.nodes:
            if n.get("id") not in reachable:
                issues.append(issue("error", "E_UNREACHABLE", "节点从 start 不可达", node=n.get("id")))
        can_end = _can_reach_end(snap)
        for n in snap.nodes:
            if n.get("id") in reachable and n.get("id") not in can_end:
                issues.append(issue("warning", "W_NO_END_PATH", "该节点无法到达任何 end", node=n.get("id")))

    # ---- 网关与节点配置
    depth_error = _check_parallel_depth(snap, starts[0]["id"]) if len(starts) == 1 else None
    if depth_error:
        issues.append(depth_error)

    for n in snap.nodes:
        nid = n.get("id")
        ntype = n.get("type")
        outs = snap.out_edges.get(nid, [])

        if ntype == "exclusive_gateway":
            if len(outs) < 2:
                issues.append(issue("warning", "W_XOR_SINGLE", "排他网关只有一条出边，等同于直连", node=nid))
            if not any(_is_default_condition(e.get("condition")) for e in outs):
                issues.append(issue("error", "E_XOR_DEFAULT", "排他网关必须有默认边（条件为空或 true）", node=nid))

        elif ntype == "parallel_gateway":
            direction = snap.gateway_direction(n)
            if direction == "fork":
                if len(outs) < 2:
                    issues.append(issue("error", "E_FORK_OUT", "并行 fork 至少两条出边", node=nid))
                if any((e.get("condition") or "").strip() not in ("", "true") for e in outs):
                    issues.append(
                        issue("error", "E_FORK_COND", "并行 fork 的出边不允许条件（条件是排他网关的事）", node=nid)
                    )
            elif direction == "join":
                if len(snap.in_edges.get(nid, [])) < 2:
                    issues.append(issue("error", "E_JOIN_IN", "并行 join 至少两条入边", node=nid))
                if len(outs) != 1:
                    issues.append(issue("error", "E_JOIN_OUT", "并行 join 必须只有一条出边", node=nid))
            else:
                issues.append(issue("error", "E_GATEWAY_DIR", "无法判定并行网关是 fork 还是 join", node=nid))

        elif ntype == "approval":
            if not n.get("assignee"):
                issues.append(issue("error", "E_ASSIGNEE", "审批节点缺少 assignee 解析器", node=nid))
            mode = n.get("signMode") or "any"
            if mode not in SIGN_MODES:
                issues.append(issue("error", "E_SIGN_MODE", f"signMode 不合法：{mode}", node=nid))
            strategy = n.get("rejectStrategy") or "terminate"
            if strategy not in REJECT_STRATEGIES:
                issues.append(
                    issue("error", "E_REJECT_STRATEGY", f"rejectStrategy 不合法：{strategy}（本期只支持 to_start/terminate）", node=nid)
                )
            policy = n.get("emptyPolicy") or "admins"
            if policy not in EMPTY_ASSIGNEE_POLICIES:
                issues.append(issue("error", "E_EMPTY_POLICY", f"emptyPolicy 不合法：{policy}", node=nid))
            if not n.get("formRef"):
                issues.append(issue("warning", "W_NO_FORM", "审批节点没有绑定表单，只能填意见", node=nid))

        elif ntype == "form":
            if not n.get("assignee"):
                issues.append(issue("error", "E_ASSIGNEE", "表单节点缺少 assignee 解析器", node=nid))
            if not n.get("formRef"):
                issues.append(issue("error", "E_FORM_REQUIRED", "表单节点必须绑定表单", node=nid))

        elif ntype == "script":
            src = n.get("script") or ""
            if not src.strip():
                issues.append(issue("error", "E_SCRIPT_EMPTY", "脚本节点没有脚本体", node=nid))
            else:
                try:
                    compile(src, f"<{nid}>", "exec")
                except SyntaxError as e:
                    issues.append(issue("error", "E_SCRIPT_SYNTAX", f"脚本语法错误：{e.msg}（第 {e.lineno} 行）", node=nid))
                if "def run(" not in src:
                    issues.append(issue("error", "E_SCRIPT_ENTRY", "脚本必须定义 run(ctx, local, env, logger, now)", node=nid))
            on_error = n.get("onErrorEdge")
            if on_error and on_error not in snap.edge_map:
                issues.append(issue("error", "E_ON_ERROR_EDGE", f"onErrorEdge 指向不存在的边：{on_error}", node=nid))

        # ---- 表单引用与字段权限
        form_ref = n.get("formRef")
        if form_ref:
            schema = form_schemas.get(form_ref)
            if schema is None:
                issues.append(issue("error", "E_FORM_NOT_FOUND", f"引用的表单未发布或不存在：{form_ref}", node=nid))
            else:
                field_names = {f.get("name") for f in schema.get("fields", []) if f.get("name")}
                for fname, perm in (n.get("fieldPermissions") or {}).items():
                    if fname not in field_names:
                        issues.append(
                            issue("warning", "W_FORM_UNKNOWN_FIELD", f"字段权限引用了表单里不存在的字段：{fname}", node=nid)
                        )
                    if (perm or {}).get("access") not in ("editable", "readonly", "hidden", None):
                        issues.append(issue("error", "E_FIELD_ACCESS", f"字段 {fname} 的 access 不合法", node=nid))

        if n.get("resubmitMode") and n.get("resubmitMode") != "restart":
            issues.append(issue("error", "E_RESUBMIT_MODE", "本期重提语义只支持 restart（全部重走）", node=nid))

    # ---- 边条件表达式
    for e in snap.edges:
        cond = e.get("condition")
        if cond is None or str(cond).strip() == "":
            continue
        try:
            validate_expr(str(cond))
        except ExprError as ex:
            issues.append(issue("error", "E_EXPR", f"边条件表达式不合法：{ex}", edge=e.get("id")))
            continue
        unknown = expr_names(str(cond)) - snap.variable_names - {"verdict", "task", "local", "env", "ctx"}
        for name in sorted(unknown):
            issues.append(
                issue("warning", "W_VAR_UNDECLARED", f"表达式引用了未声明的变量：{name}", edge=e.get("id"))
            )

    if not any(n.get("type") in ("approval", "form") for n in snap.nodes):
        issues.append(issue("warning", "W_NO_HUMAN", "流程里没有任何人工节点"))

    return issues


def _is_default_condition(cond) -> bool:
    return cond is None or str(cond).strip() in ("", "true")


def _reachable(snap: Snapshot, start_id: str) -> set[str]:
    seen = {start_id}
    q = deque([start_id])
    while q:
        cur = q.popleft()
        for e in snap.out_edges.get(cur, []):
            nxt = e.get("to")
            if nxt and nxt not in seen:
                seen.add(nxt)
                q.append(nxt)
    return seen


def _can_reach_end(snap: Snapshot) -> set[str]:
    reverse: dict[str, list[str]] = defaultdict(list)
    for e in snap.edges:
        reverse[e.get("to")].append(e.get("from"))
    seen = {n["id"] for n in snap.nodes if n.get("type") == "end"}
    q = deque(seen)
    while q:
        cur = q.popleft()
        for prev in reverse.get(cur, []):
            if prev and prev not in seen:
                seen.add(prev)
                q.append(prev)
    return seen


def _check_parallel_depth(snap: Snapshot, start_id: str) -> dict | None:
    """并行嵌套深度检查（PRD §9.2 默认 ≤3）。DFS 计数，遇 fork+1、join-1。"""
    max_depth = settings.MAX_PARALLEL_DEPTH
    stack = [(start_id, 0)]
    visited_best: dict[str, int] = {}
    while stack:
        nid, depth = stack.pop()
        if depth > max_depth:
            return issue("error", "E_PARALLEL_DEPTH", f"并行嵌套超过 {max_depth} 层", node=nid)
        if visited_best.get(nid, -1) >= depth:
            continue
        visited_best[nid] = depth
        node = snap.node(nid) or {}
        nxt_depth = depth
        if node.get("type") == "parallel_gateway" and snap.gateway_direction(node) == "fork":
            nxt_depth = depth + 1
        for e in snap.out_edges.get(nid, []):
            if e.get("to"):
                stack.append((e["to"], nxt_depth))
    return None


def auto_layout(data: dict) -> dict:
    """没有 position 的节点按 BFS 分层给坐标（设计器用）。原地修改并返回。"""
    snap = Snapshot(data)
    start = snap.start_node()
    if not start:
        return data
    level: dict[str, int] = {start["id"]: 0}
    q = deque([start["id"]])
    while q:
        cur = q.popleft()
        for e in snap.out_edges.get(cur, []):
            nxt = e.get("to")
            if nxt and nxt not in level:
                level[nxt] = level[cur] + 1
                q.append(nxt)
    per_level: dict[int, int] = defaultdict(int)
    for n in data.get("nodes", []):
        pos = n.get("position")
        if not pos or not isinstance(pos, dict) or "x" not in pos or "y" not in pos:
            lv = level.get(n.get("id"), 0)
            n["position"] = {"x": 80 + lv * 200, "y": 80 + per_level[lv] * 110}
        per_level[level.get(n.get("id"), 0)] += 1
    return data
