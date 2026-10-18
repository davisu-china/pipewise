"""执行引擎：令牌驱动的状态机（技术方案 §3）。

一句话模型：**实例 = 一组令牌 + 一组等待中的人工任务**。每次动作都在一个事务里
「锁实例 → 推进所有可自动执行的令牌 → 停在人工/结束点」，提交即生效。
"""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select, update
from sqlalchemy.orm import Session

from ..config import settings
from ..models import (
    Definition,
    Instance,
    NodeInstance,
    Outbox,
    Task,
    Token,
    User,
    Variable,
    Version,
)
from . import forms as forms_engine
from .assignee import resolve_assignees
from .context import (
    coerce_declared,
    env_snapshot,
    process_vars,
    sensitive_names,
    write_vars,
)
from .errors import ApiError, conflict, forbidden, not_found
from .expr import ExprError, evaluate
from .graph import Snapshot
from .script import run_script

ACTIVE = "ACTIVE"
WAITING = "WAITING"
CONSUMED = "CONSUMED"

TERMINAL_INSTANCE = {"COMPLETED", "TERMINATED", "FAILED"}


def _now() -> datetime:
    return datetime.now(timezone.utc)


class Engine:
    def __init__(self) -> None:
        self._snap_cache: dict[int, Snapshot] = {}

    # ------------------------------------------------------------------ 读取

    def snapshot(self, session: Session, instance: Instance) -> Snapshot:
        snap = self._snap_cache.get(instance.version_id)
        if snap is None:
            version = session.get(Version, instance.version_id)
            if version is None:
                raise ApiError(500, "VERSION_MISSING", f"实例钉的版本不存在：{instance.version_id}")
            snap = Snapshot(version.snapshot_json)
            self._snap_cache[instance.version_id] = snap
        return snap

    def lock_instance(self, session: Session, instance_id: int) -> Instance:
        inst = session.execute(
            select(Instance).where(Instance.id == instance_id).with_for_update()
        ).scalar_one_or_none()
        if inst is None:
            raise not_found("实例")
        return inst

    # ------------------------------------------------------------------ 创建

    def create_instance(
        self,
        session: Session,
        *,
        definition: Definition,
        version: Version,
        business_key: str,
        initiator: str,
        title: str | None,
        variables: dict[str, Any],
        actor: str,
        dry_run: bool = False,
    ) -> tuple[Instance, bool]:
        existing = session.execute(
            select(Instance).where(
                Instance.definition_id == definition.id,
                Instance.business_key == business_key,
            )
        ).scalar_one_or_none()
        if existing:
            return existing, True

        snap = Snapshot(version.snapshot_json)
        cleaned: dict[str, Any] = dict(variables or {})
        for decl in snap.variables:
            name = decl.get("name")
            if name not in cleaned:
                if decl.get("default") is not None:
                    cleaned[name] = decl["default"]
                continue
            ok, value, err = coerce_declared(decl, cleaned[name])
            if not ok:
                raise ApiError(400, "VARIABLE_INVALID", err or "变量不合法", {"field": name})
            cleaned[name] = value
        for decl in snap.variables:
            if decl.get("required") and (cleaned.get(decl.get("name")) in (None, "")):
                raise ApiError(
                    400, "VARIABLE_REQUIRED", f"变量 {decl.get('name')} 必填", {"field": decl.get("name")}
                )

        inst = Instance(
            definition_id=definition.id,
            version_id=version.id,
            definition_key=definition.key,
            business_key=business_key,
            title=title,
            initiator=initiator,
            status="RUNNING",
            step_count=0,
            resubmit_mode="restart",
            dry_run=dry_run,
            started_at=_now(),
        )
        session.add(inst)
        session.flush()

        if cleaned:
            write_vars(
                session,
                inst,
                cleaned,
                actor=actor,
                actor_type="user",
                sensitive_names=sensitive_names(version.snapshot_json),
            )

        self._audit(
            session,
            inst,
            "instance.created",
            actor,
            {"definition": definition.key, "version": version.version, "businessKey": business_key},
        )
        self._event(session, inst, "instance.created", {"status": inst.status})

        # 令牌落在 start 节点
        start = snap.start_node()
        if start is None:
            self._fail(session, inst, "快照里没有 start 节点", actor)
            return inst, False
        self._create_token(session, inst, start["id"])
        self.advance(session, inst, actor)
        return inst, False

    # ------------------------------------------------------------------ 推进

    def advance(self, session: Session, instance: Instance, actor: str = "system") -> None:
        inst = self.lock_instance(session, instance.id)
        if inst.status in TERMINAL_INSTANCE or inst.status == "SUSPENDED":
            return
        snap = self.snapshot(session, inst)

        while True:
            token = session.execute(
                select(Token)
                .where(Token.instance_id == inst.id, Token.status == ACTIVE)
                .order_by(Token.id)
                .limit(1)
            ).scalar_one_or_none()
            if token is None:
                break
            inst.step_count += 1
            if inst.step_count > settings.MAX_STEPS:
                self._fail(session, inst, f"超过最大步数 {settings.MAX_STEPS}（疑似死循环）", actor)
                break
            self.fire(session, inst, snap, token, actor)
            if inst.status != "RUNNING":
                break

        self._settle(session, inst)

    def fire(self, session: Session, inst: Instance, snap: Snapshot, token: Token, actor: str) -> None:
        node = snap.node(token.node_id)
        if node is None:
            self._fail(session, inst, f"令牌指向的节点不存在：{token.node_id}", actor)
            return
        ntype = node.get("type")

        # join 是唯一"到达时不创建节点实例"的节点：它要等入边到齐
        if ntype == "parallel_gateway" and snap.gateway_direction(node) == "join":
            self._fire_join(session, inst, snap, node, token, actor)
            return

        ni = self._new_node_instance(session, inst, node, token, actor)
        if ni is None:
            return  # 激活次数超限，已 fail

        handler = {
            "start": self._fire_start,
            "end": self._fire_end,
            "script": self._fire_script,
            "exclusive_gateway": self._fire_exclusive,
            "parallel_gateway": self._fire_fork,
            "approval": self._fire_human,
            "form": self._fire_human,
        }.get(ntype)
        if handler is None:
            self._fail(session, inst, f"不支持的节点类型：{ntype}", actor)
            return
        handler(session, inst, snap, node, token, ni, actor)

    # ---------------------------------------------------------------- 节点实现

    def _fire_start(self, session, inst, snap, node, token, ni, actor) -> None:
        outs = snap.out_edges.get(node["id"], [])
        if not outs:
            self._fail(session, inst, "start 节点没有出边", actor)
            return
        self._complete_node(session, ni, {"edge": outs[0]["id"]})
        self._emit_next(session, inst, token, [outs[0]])

    def _fire_end(self, session, inst, snap, node, token, ni, actor) -> None:
        self._complete_node(session, ni, {})
        token.status = CONSUMED
        session.flush()

    def _fire_script(self, session, inst, snap, node, token, ni, actor) -> None:
        ctx = process_vars(session, inst.id)
        env = env_snapshot(session)
        retries = int(node.get("retries") or 0)
        result = None
        for attempt in range(retries + 1):
            ni.attempt = attempt + 1
            result = run_script(
                node.get("script") or "",
                ctx,
                {},
                env,
                timeout_ms=node.get("timeoutMs") or settings.SCRIPT_TIMEOUT_MS,
            )
            if result.ok:
                break
        assert result is not None

        if not result.ok:
            ni.status = "FAILED"
            ni.error = result.error
            ni.ended_at = _now()
            self._audit(
                session,
                inst,
                "script.failed",
                actor,
                {"node": node["id"], "error": result.error, "trace": result.trace},
                node_instance_id=ni.id,
            )
            on_error = node.get("onErrorEdge")
            edge = snap.edge_map.get(on_error) if on_error else None
            if edge:
                ni.status = "COMPLETED"
                ni.result_json = {"error": result.error, "edge": edge["id"]}
                self._emit_next(session, inst, token, [edge])
                return
            self._fail(session, inst, f"脚本节点 {node['id']} 执行失败：{result.error}", actor, ni.id)
            return

        # 成功：返回值写 local；按 outputMapping（缺省=全部返回键）写流程级
        merged_local = {**result.local, **result.result}
        mapping = node.get("outputMapping") or {}
        if mapping:
            ctx_updates = {ctx_name: merged_local.get(local_name) for ctx_name, local_name in mapping.items()}
        else:
            ctx_updates = {**result.sets, **result.result}
        ctx_updates = {k: v for k, v in ctx_updates.items() if v is not None}

        session.execute(
            update(NodeInstance)
            .where(NodeInstance.id == ni.id)
            .values(local_json=merged_local, result_json=result.result)
        )
        if ctx_updates:
            try:
                write_vars(
                    session,
                    inst,
                    ctx_updates,
                    actor=actor,
                    actor_type="script",
                    # 流程级变量必须落 node_instance_id=0（局部作用域才用节点 id）
                    node_instance_id=0,
                    conflict_mode="retry" if node.get("onConflict", "fail") == "retry" else node.get("onConflict", "fail"),
                    sensitive_names=sensitive_names(snap.data),
                    audit_node_instance_id=ni.id,
                )
            except Exception as e:  # VariableConflict 或其它写失败
                ni.status = "FAILED"
                ni.error = str(e)
                ni.ended_at = _now()
                self._fail(session, inst, f"脚本写上下文失败：{e}", actor, ni.id)
                return
        ni.local_json = merged_local

        self._audit(
            session,
            inst,
            "script.executed",
            actor,
            {
                "node": node["id"],
                "outputs": {k: v for k, v in (result.result or {}).items() if k not in sensitive_names(snap.data)},
                "durationMs": result.duration_ms,
                "logs": result.logs[-20:],
            },
            node_instance_id=ni.id,
        )

        outs = snap.out_edges.get(node["id"], [])
        if not outs:
            self._fail(session, inst, "脚本节点没有出边", actor, ni.id)
            return
        if len(outs) == 1:
            chosen = outs[0]
        else:
            chosen = self._choose_exclusive(session, inst, snap, outs, ctx)
            if chosen is None:
                self._fail(session, inst, "脚本节点的出边条件都没有命中", actor, ni.id)
                return
        self._complete_node(session, ni, {"edge": chosen["id"]})
        self._emit_next(session, inst, token, [chosen])

    def _fire_exclusive(self, session, inst, snap, node, token, ni, actor) -> None:
        ctx = process_vars(session, inst.id)
        chosen = self._choose_exclusive(session, inst, snap, snap.out_edges.get(node["id"], []), ctx)
        if chosen is None:
            self._fail(session, inst, f"排他网关 {node['id']} 没有匹配的出边且无默认边", actor, ni.id)
            return
        self._complete_node(session, ni, {"edge": chosen["id"]})
        self._emit_next(session, inst, token, [chosen])

    def _choose_exclusive(self, session, inst, snap, edges, ctx) -> dict | None:
        default_edge = None
        for e in edges:
            cond = e.get("condition")
            if cond is None or str(cond).strip() in ("", "true"):
                default_edge = default_edge or e
                continue
            try:
                ok = evaluate(str(cond), ctx)
            except ExprError:
                raise
            if ok:
                return e
        return default_edge

    def _fire_fork(self, session, inst, snap, node, token, ni, actor) -> None:
        outs = snap.out_edges.get(node["id"], [])
        self._complete_node(session, ni, {"branches": [e["id"] for e in outs]})
        self._emit_next(session, inst, token, outs)

    def _fire_join(self, session, inst, snap, node, token, actor) -> None:
        """join：按**入边**计数，全部到齐才合并。"""
        expected = {e["id"] for e in snap.in_edges.get(node["id"], [])}
        # 记录本次到达
        token.status = WAITING
        if not token.arrived_edge:
            # 兜底：从上一节点推断（正常路径由 _emit_next 填好）
            token.arrived_edge = None
        session.flush()

        waiting = session.execute(
            select(Token).where(
                Token.instance_id == inst.id,
                Token.node_id == node["id"],
                Token.status == WAITING,
            )
        ).scalars().all()
        arrived = {t.arrived_edge for t in waiting if t.arrived_edge}
        if not expected.issubset(arrived):
            self._audit(
                session,
                inst,
                "join.waiting",
                actor,
                {"node": node["id"], "arrived": sorted(arrived), "expected": sorted(expected)},
            )
            return

        # 到齐：消费这些令牌，产出一条新令牌
        for t in waiting:
            t.status = CONSUMED
        seq = self._next_seq(session, inst.id, node["id"])
        if seq > settings.MAX_NODE_ACTIVATIONS:
            self._fail(session, inst, f"节点 {node['id']} 激活次数超过 {settings.MAX_NODE_ACTIVATIONS}", actor)
            return
        ji = NodeInstance(
            instance_id=inst.id,
            node_id=node["id"],
            node_type="parallel_gateway",
            status="COMPLETED",
            activation_seq=seq,
            local_json={},
            result_json={"joined": sorted(arrived)},
            started_at=_now(),
            ended_at=_now(),
        )
        session.add(ji)
        session.flush()
        outs = snap.out_edges.get(node["id"], [])
        if len(outs) != 1:
            self._fail(session, inst, "join 必须只有一条出边", actor, ji.id)
            return
        self._emit_next(session, inst, token, outs)
        self._audit(session, inst, "join.completed", actor, {"node": node["id"]}, node_instance_id=ji.id)

    def _fire_human(self, session, inst, snap, node, token, ni, actor) -> None:
        mode = node.get("signMode") or "any"
        if node.get("type") == "form":
            mode = "first"
        ni.status = WAITING
        ni.result_json = {"signMode": mode}
        token.status = WAITING

        ctx = process_vars(session, inst.id)
        assignees = resolve_assignees(session, node.get("assignee"), inst, ctx)
        if not assignees:
            policy = node.get("emptyPolicy") or "admins"
            if policy == "auto_approve":
                self._audit(
                    session, inst, "assignee.empty_auto_approve", actor, {"node": node["id"]}, node_instance_id=ni.id
                )
                self._complete_node(session, ni, {"auto": True})
                outs = snap.out_edges.get(node["id"], [])
                if len(outs) == 1:
                    self._emit_next(session, inst, token, outs)
                else:
                    chosen = self._choose_exclusive(session, inst, snap, outs, ctx)
                    if chosen is None:
                        self._fail(session, inst, "审批人解析为空且无默认出边", actor, ni.id)
                        return
                    self._emit_next(session, inst, token, [chosen])
                return
            if policy == "fail":
                self._fail(session, inst, f"节点 {node['id']} 审批人解析为空", actor, ni.id)
                return
            # 默认：指派给管理员
            admins = [u.id for u in session.execute(select(User)).scalars() if "admin" in (u.roles or [])]
            if not admins:
                self._fail(session, inst, f"节点 {node['id']} 审批人解析为空且没有管理员可指派", actor, ni.id)
                return
            assignees = admins
            self._audit(
                session, inst, "assignee.empty_to_admin", actor, {"node": node["id"], "admins": admins}, node_instance_id=ni.id
            )

        kind = node.get("type")  # approval | form
        for uid in assignees:
            task = Task(
                instance_id=inst.id,
                node_instance_id=ni.id,
                node_id=node["id"],
                kind="approval" if kind == "approval" else "form",
                assignee=uid,
                status="CREATED",
            )
            session.add(task)
        session.flush()
        task_rows = self._tasks_of(session, ni.id)
        self._audit(
            session,
            inst,
            "node.activated",
            actor,
            {"node": node["id"], "type": kind, "assignees": assignees, "signMode": mode},
            node_instance_id=ni.id,
        )
        self._event(
            session,
            inst,
            "task.created",
            {"node_id": node["id"], "tasks": [{"id": t.id, "assignee": t.assignee} for t in task_rows]},
        )

    # ------------------------------------------------------------------ 任务

    def complete_task(
        self,
        session: Session,
        task_id: int,
        actor: str,
        *,
        verdict: str | None = None,
        comment: str | None = None,
        form_data: dict | None = None,
        actor_type: str = "user",
        submitted: dict | None = None,
    ) -> Task:
        task = session.get(Task, task_id)
        if task is None:
            raise not_found("任务")
        inst = self.lock_instance(session, task.instance_id)
        snap = self.snapshot(session, inst)
        node = snap.node(task.node_id)
        if node is None:
            raise ApiError(500, "NODE_MISSING", f"任务指向的节点不存在：{task.node_id}")

        if actor_type != "admin" and task.assignee != actor:
            raise forbidden("这条任务不是指派给你的")
        # 先看任务本身：已结束的任务给出 TASK_ALREADY_DONE（比"实例不可操作"更准确）
        if task.status not in ("CREATED", "CLAIMED"):
            raise conflict("TASK_ALREADY_DONE", "任务已经被处理过了")
        ni = session.get(NodeInstance, task.node_instance_id)
        if ni is None or ni.status != "WAITING":
            raise conflict("TASK_ALREADY_DONE", "任务所在节点已经结束")

        if inst.status == "SUSPENDED":
            raise conflict("INSTANCE_SUSPENDED", "实例已挂起，任务暂时不能操作")
        if inst.status != "RUNNING":
            raise conflict("INSTANCE_NOT_RUNNING", f"实例状态为 {inst.status}，任务不可操作")

        # 表单校验与写入（提交表单和完成任务是同一个事务，PRD §10.11）
        dropped: list[dict] = []
        if submitted is not None:
            schema = self._form_schema_for(session, inst, node)
            if schema is None:
                raise ApiError(500, "FORM_MISSING", "节点绑定的表单不存在")
            existing = process_vars(session, inst.id)
            updates, dropped, errors = forms_engine.validate_submission(
                schema, node.get("fieldPermissions") or {}, submitted, existing
            )
            if errors:
                raise ApiError(400, "FORM_VALIDATION_FAILED", "表单校验未通过", {"errors": errors})
            if updates:
                write_vars(
                    session,
                    inst,
                    updates,
                    actor=actor,
                    actor_type="admin" if actor_type == "admin" else "user",
                    node_instance_id=0,
                    sensitive_names=sensitive_names(snap.data),
                    audit_node_instance_id=ni.id,
                )
            from ..models import FormData

            session.add(
                FormData(
                    instance_id=inst.id,
                    node_instance_id=ni.id,
                    task_id=task.id,
                    form_version_id=self._form_version_id(session, inst, node),
                    data_json=submitted,
                )
            )
            if dropped:
                self._audit(
                    session, inst, "form.unauthorized_fields_dropped", actor, {"dropped": dropped}, node_instance_id=ni.id
                )

        # 任务终态（带状态条件 → 并发/双击只生效一次）
        if task.kind in ("form", "resubmit"):
            verdict = verdict or "submit"
        if verdict is None:
            raise ApiError(400, "VERDICT_REQUIRED", "需要 verdict（approve/reject）")
        if verdict not in ("approve", "reject", "submit"):
            raise ApiError(400, "VERDICT_INVALID", f"verdict 不合法：{verdict}")

        res = session.execute(
            update(Task)
            .where(Task.id == task.id, Task.status.in_(("CREATED", "CLAIMED")))
            .values(
                status="COMPLETED",
                verdict=verdict,
                comment=comment,
                form_data=form_data if form_data is not None else submitted,
                completed_at=_now(),
            )
        )
        if res.rowcount == 0:
            raise conflict("TASK_ALREADY_DONE", "任务已经被处理过了")
        session.expire(task)

        self._audit(
            session,
            inst,
            "task.completed",
            actor,
            {"node": node["id"], "verdict": verdict, "comment": comment, "actorType": actor_type},
            node_instance_id=ni.id,
        )
        self._event(
            session,
            inst,
            "task.completed",
            {"node_id": node["id"], "task_id": task.id, "assignee": task.assignee, "verdict": verdict},
        )

        # 重提单：直接回到 start 重新走
        if task.kind == "resubmit":
            self._cancel_tasks(session, ni.id, "重提已提交")
            self._complete_node(session, ni, {"resubmitted": True})
            outs = snap.out_edges.get(node["id"], [])
            if len(outs) != 1:
                self._fail(session, inst, "start 节点必须有且只有一条出边", actor, ni.id)
                return task
            self._create_token(session, inst, node["id"])
            self.advance(session, inst, actor)
            return task

        # 表单节点：任一提交即完成
        if node.get("type") == "form":
            self._cancel_tasks(session, ni.id, "节点已由他人完成")
            self._complete_node(session, ni, {"verdict": verdict})
            self._advance_from_node(session, inst, snap, node, ni, verdict, actor)
            self.advance(session, inst, actor)
            return task

        # 审批节点：按签核模式裁决
        decision = self._decide(session, node, ni, verdict)
        if decision is None:
            self.advance(session, inst, actor)
            return task
        self._cancel_tasks(session, ni.id, f"节点已{ '通过' if decision == 'approve' else '否决' }")
        self._complete_node(session, ni, {"verdict": decision})
        if decision == "approve":
            self._advance_from_node(session, inst, snap, node, ni, "approve", actor)
        else:
            self._apply_reject(session, inst, snap, node, ni, actor)
        self.advance(session, inst, actor)
        return task

    def _decide(self, session: Session, node: dict, ni: NodeInstance, last_verdict: str) -> str | None:
        tasks = self._tasks_of(session, ni.id)
        mode = node.get("signMode") or "any"
        approves = [t for t in tasks if t.status == "COMPLETED" and t.verdict == "approve"]
        rejects = [t for t in tasks if t.status == "COMPLETED" and t.verdict == "reject"]
        pending = [t for t in tasks if t.status in ("CREATED", "CLAIMED")]

        if mode == "race":
            # 第一个完成的即是结论（调用前任务已落库）
            return "approve" if last_verdict == "approve" else "reject"

        if mode == "any":
            if last_verdict == "approve":
                return "approve"
            if not pending and not approves:
                return "reject"
            return None

        # all（会签）
        ratio = float(node.get("approveRatio") or 1.0)
        veto = node.get("vetoOnReject", True)
        if last_verdict == "reject" and veto:
            return "reject"
        total = len(tasks)
        if pending:
            return None
        approved_ratio = (len(approves) / total) if total else 0.0
        return "approve" if approved_ratio >= ratio and not (veto and rejects) else "reject"

    def _apply_reject(self, session, inst, snap, node, ni, actor) -> None:
        strategy = node.get("rejectStrategy") or "terminate"
        if strategy == "terminate":
            self._finish(session, inst, "COMPLETED", "rejected", actor, f"节点 {node['id']} 否决")
            return
        if strategy != "to_start":
            self._fail(session, inst, f"不支持的 rejectStrategy：{strategy}", actor, ni.id)
            return

        # 退回发起人：回收所有令牌与在途任务，给发起人一张"重提单"
        self._cancel_all_tasks(session, inst, "流程被退回")
        session.execute(
            update(Token)
            .where(Token.instance_id == inst.id, Token.status.in_((ACTIVE, WAITING)))
            .values(status=CONSUMED)
        )
        start = snap.start_node()
        if start is None:
            self._fail(session, inst, "快照里没有 start 节点", actor)
            return
        seq = self._next_seq(session, inst.id, start["id"])
        rni = NodeInstance(
            instance_id=inst.id,
            node_id=start["id"],
            node_type="start",
            status="WAITING",
            activation_seq=seq,
            local_json={},
            result_json={"resubmit": True},
            started_at=_now(),
        )
        session.add(rni)
        session.flush()
        session.add(
            Task(
                instance_id=inst.id,
                node_instance_id=rni.id,
                node_id=start["id"],
                kind="resubmit",
                assignee=inst.initiator,
                status="CREATED",
            )
        )
        session.flush()
        self._audit(
            session,
            inst,
            "instance.returned_to_start",
            actor,
            {"node": node["id"], "resubmitTask": self._tasks_of(session, rni.id)[0].id},
            node_instance_id=ni.id,
        )
        self._event(session, inst, "instance.returned", {"node_id": node["id"], "to": inst.initiator})

    def _advance_from_node(self, session, inst, snap, node, ni, verdict: str, actor: str) -> None:
        token = session.get(Token, ni.token_id) if ni.token_id else None
        if token is not None and token.status != WAITING:
            token = None
        if token is None:
            token = session.execute(
                select(Token).where(
                    Token.instance_id == inst.id, Token.node_id == node["id"], Token.status == WAITING
                )
            ).scalars().first()
        outs = snap.out_edges.get(node["id"], [])
        if not outs:
            self._fail(session, inst, f"节点 {node['id']} 没有出边", actor, ni.id)
            return
        if len(outs) == 1:
            chosen = outs[0]
        else:
            ctx = process_vars(session, inst.id)
            try:
                chosen = self._choose_exclusive(session, inst, snap, outs, ctx)
            except ExprError as e:
                self._fail(session, inst, f"出边条件求值失败：{e}", actor, ni.id)
                return
            if chosen is None:
                self._fail(session, inst, f"节点 {node['id']} 没有匹配的出边", actor, ni.id)
                return
        if token is None:
            self._fail(session, inst, "节点结束时找不到对应令牌", actor, ni.id)
            return
        self._emit_next(session, inst, token, [chosen])

    # ------------------------------------------------------------------ 生命周期

    def suspend(self, session: Session, inst_id: int, actor: str) -> None:
        inst = self.lock_instance(session, inst_id)
        if inst.status != "RUNNING":
            raise conflict("INVALID_STATE", f"实例状态为 {inst.status}，不能挂起")
        inst.status = "SUSPENDED"
        self._audit(session, inst, "instance.suspended", actor, {})
        self._event(session, inst, "instance.suspended", {})
        session.flush()

    def resume(self, session: Session, inst_id: int, actor: str) -> None:
        inst = self.lock_instance(session, inst_id)
        if inst.status != "SUSPENDED":
            raise conflict("INVALID_STATE", f"实例状态为 {inst.status}，不能恢复")
        inst.status = "RUNNING"
        self._audit(session, inst, "instance.resumed", actor, {})
        self._event(session, inst, "instance.resumed", {})
        session.flush()
        self.advance(session, inst, actor)

    def terminate(self, session: Session, inst_id: int, actor: str, reason: str | None = None) -> None:
        inst = self.lock_instance(session, inst_id)
        if inst.status in TERMINAL_INSTANCE:
            raise conflict("INVALID_STATE", f"实例已结束（{inst.status}）")
        self._finish(session, inst, "TERMINATED", "terminated", actor, reason or "人工终止")

    def withdraw(self, session: Session, inst_id: int, actor: str) -> None:
        inst = self.lock_instance(session, inst_id)
        if inst.initiator != actor:
            raise forbidden("只有发起人可以撤回")
        if inst.status != "RUNNING":
            raise conflict("INVALID_STATE", f"实例状态为 {inst.status}，不能撤回")
        handled = session.execute(
            select(func.count(Task.id)).where(Task.instance_id == inst.id, Task.status == "COMPLETED")
        ).scalar_one()
        if handled:
            raise conflict("WITHDRAW_TOO_LATE", "已经有任务被处理过，不能撤回")
        self._finish(session, inst, "TERMINATED", "terminated", actor, "发起人撤回")

    def force_complete_task(
        self, session: Session, task_id: int, actor: str, verdict: str, comment: str | None = None
    ) -> Task:
        return self.complete_task(
            session, task_id, actor, verdict=verdict, comment=comment, actor_type="admin"
        )

    def set_variable(self, session: Session, inst_id: int, name: str, value: Any, actor: str) -> None:
        inst = self.lock_instance(session, inst_id)
        write_vars(session, inst, {name: value}, actor=actor, actor_type="admin", conflict_mode="last_write_wins")
        self._audit(session, inst, "variable.set_by_admin", actor, {"name": name, "value": value})

    def retry_failed(self, session: Session, inst_id: int, actor: str) -> None:
        inst = self.lock_instance(session, inst_id)
        if inst.status != "FAILED":
            raise conflict("INVALID_STATE", f"实例状态为 {inst.status}，只有 FAILED 可以重试")
        last = session.execute(
            select(NodeInstance)
            .where(NodeInstance.instance_id == inst.id, NodeInstance.status == "FAILED")
            .order_by(NodeInstance.id.desc())
            .limit(1)
        ).scalar_one_or_none()
        if last is None:
            raise conflict("NO_FAILED_NODE", "找不到失败节点")
        inst.status = "RUNNING"
        inst.outcome = None
        session.flush()
        self._create_token(session, inst, last.node_id)
        self._audit(session, inst, "instance.retried", actor, {"node": last.node_id})
        self._event(session, inst, "instance.resumed", {"retry": True})
        self.advance(session, inst, actor)

    # ------------------------------------------------------------------ 内部工具

    def _new_node_instance(self, session, inst, node, token, actor) -> NodeInstance | None:
        seq = self._next_seq(session, inst.id, node["id"])
        if seq > settings.MAX_NODE_ACTIVATIONS:
            self._fail(session, inst, f"节点 {node['id']} 激活次数超过 {settings.MAX_NODE_ACTIVATIONS}", actor)
            return None
        ni = NodeInstance(
            instance_id=inst.id,
            node_id=node["id"],
            node_type=node.get("type") or "unknown",
            status="RUNNING",
            token_id=token.id,
            activation_seq=seq,
            local_json={},
            started_at=_now(),
        )
        session.add(ni)
        session.flush()
        return ni

    def _next_seq(self, session, instance_id: int, node_id: str) -> int:
        count = session.execute(
            select(func.count(NodeInstance.id)).where(
                NodeInstance.instance_id == instance_id, NodeInstance.node_id == node_id
            )
        ).scalar_one()
        return int(count) + 1

    def _complete_node(self, session, ni: NodeInstance, result: dict) -> None:
        ni.status = "COMPLETED"
        ni.result_json = {**(ni.result_json or {}), **result}
        ni.ended_at = _now()
        session.flush()

    def _create_token(self, session, inst, node_id: str, parent_token_id: int | None = None, edge_id: str | None = None) -> Token:
        token = Token(
            instance_id=inst.id,
            node_id=node_id,
            status=ACTIVE,
            parent_token_id=parent_token_id,
            arrived_edge=edge_id,
        )
        session.add(token)
        session.flush()
        return token

    def _emit_next(self, session, inst, token: Token, edges: list[dict]) -> None:
        token.status = CONSUMED
        for e in edges:
            self._create_token(session, inst, e["to"], parent_token_id=token.id, edge_id=e["id"])
        session.flush()

    def _tasks_of(self, session, node_instance_id: int) -> list[Task]:
        return list(
            session.execute(
                select(Task)
                .where(Task.node_instance_id == node_instance_id)
                .order_by(Task.id)
                .execution_options(populate_existing=True)
            ).scalars()
        )

    def _cancel_tasks(self, session, node_instance_id: int, reason: str) -> None:
        session.execute(
            update(Task)
            .where(Task.node_instance_id == node_instance_id, Task.status.in_(("CREATED", "CLAIMED")))
            .values(status="CANCELLED", comment=reason)
        )

    def _cancel_all_tasks(self, session, inst: Instance, reason: str) -> None:
        session.execute(
            update(Task)
            .where(Task.instance_id == inst.id, Task.status.in_(("CREATED", "CLAIMED")))
            .values(status="CANCELLED", comment=reason)
        )

    def _form_schema_for(self, session, inst: Instance, node: dict) -> dict | None:
        ref = node.get("formRef")
        if not ref:
            return None
        from ..models import FormBinding, FormVersion

        binding = session.execute(
            select(FormBinding).where(FormBinding.version_id == inst.version_id, FormBinding.node_id == node["id"])
        ).scalar_one_or_none()
        if binding:
            fv = session.get(FormVersion, binding.form_version_id)
            if fv:
                return fv.schema_json
        fv = forms_engine.get_published_form(session, ref)
        return fv.schema_json if fv else None

    def _form_version_id(self, session, inst: Instance, node: dict) -> int | None:
        from ..models import FormBinding

        binding = session.execute(
            select(FormBinding).where(FormBinding.version_id == inst.version_id, FormBinding.node_id == node["id"])
        ).scalar_one_or_none()
        return binding.form_version_id if binding else None

    def _settle(self, session, inst: Instance) -> None:
        if inst.status != "RUNNING":
            return
        live_tokens = session.execute(
            select(func.count(Token.id)).where(Token.instance_id == inst.id, Token.status.in_((ACTIVE, WAITING)))
        ).scalar_one()
        open_tasks = session.execute(
            select(func.count(Task.id)).where(Task.instance_id == inst.id, Task.status.in_(("CREATED", "CLAIMED")))
        ).scalar_one()
        if live_tokens == 0 and open_tasks == 0:
            self._finish(session, inst, "COMPLETED", "completed", "system", None)
        session.flush()

    def _fail(self, session, inst: Instance, reason: str, actor: str, node_instance_id: int | None = None) -> None:
        self._cancel_all_tasks(session, inst, f"实例失败：{reason}")
        session.execute(
            update(Token)
            .where(Token.instance_id == inst.id, Token.status.in_((ACTIVE, WAITING)))
            .values(status=CONSUMED)
        )
        inst.status = "FAILED"
        inst.outcome = "failed"
        inst.ended_at = _now()
        self._audit(session, inst, "instance.failed", actor, {"reason": reason}, node_instance_id=node_instance_id)
        self._event(session, inst, "instance.failed", {"reason": reason})
        session.flush()

    def _finish(self, session, inst: Instance, status: str, outcome: str, actor: str, reason: str | None) -> None:
        self._cancel_all_tasks(session, inst, reason or "实例结束")
        session.execute(
            update(Token)
            .where(Token.instance_id == inst.id, Token.status.in_((ACTIVE, WAITING)))
            .values(status=CONSUMED)
        )
        inst.status = status
        inst.outcome = outcome
        inst.ended_at = _now()
        self._audit(session, inst, "instance.ended", actor, {"status": status, "outcome": outcome, "reason": reason})
        self._event(session, inst, "instance.completed" if status == "COMPLETED" else "instance.terminated", {"outcome": outcome, "reason": reason})
        # autoflush 关闭：状态改动必须显式落库，否则同事务内的后续读取会看到旧值
        session.flush()

    def _audit(self, session, inst: Instance, action: str, actor: str, detail: dict, node_instance_id: int | None = None) -> None:
        from ..models import AuditLog

        session.add(
            AuditLog(
                instance_id=inst.id,
                node_instance_id=node_instance_id,
                action=action,
                actor=actor,
                detail_json=detail or {},
            )
        )

    # 给 API 层用的公开包装（保持 _audit/_event 仍是引擎内部工具）
    def audit(self, session, inst, action: str, actor: str, detail: dict, node_instance_id: int | None = None) -> None:
        self._audit(session, inst, action, actor, detail, node_instance_id)

    def emit_event(self, session, inst, event_type: str, payload: dict) -> None:
        self._event(session, inst, event_type, payload)

    def _event(self, session, inst: Instance, event_type: str, payload: dict) -> None:
        session.add(
            Outbox(
                instance_id=inst.id,
                type=event_type,
                payload_json={
                    "event_id": uuid.uuid4().hex,
                    "type": event_type,
                    "instance_id": inst.id,
                    "definition_key": inst.definition_key,
                    "business_key": inst.business_key,
                    "status": inst.status,
                    "at": _now().isoformat(),
                    **(payload or {}),
                },
            )
        )


engine = Engine()
