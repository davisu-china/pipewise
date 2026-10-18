"""把 ORM 对象转成给前端的 JSON（camelCase，和 PRD 的字段习惯一致）。"""

from __future__ import annotations

from datetime import datetime

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..engine.context import mask_vars, process_vars
from ..engine.graph import Snapshot
from ..models import AuditLog, Definition, Instance, NodeInstance, Task, Token, User, VariableLog, Version


def iso(v: datetime | None) -> str | None:
    return v.isoformat() if v else None


def user_dict(u: User | None) -> dict | None:
    if not u:
        return None
    return {"id": u.id, "name": u.name, "deptId": u.dept_id, "managerId": u.manager_id, "roles": u.roles or []}


def version_dict(v: Version, full: bool = False) -> dict:
    out = {
        "id": v.id,
        "version": v.version,
        "status": v.status,
        "publishedBy": v.published_by,
        "publishedAt": iso(v.published_at),
        "createdAt": iso(v.created_at),
    }
    if full:
        out["snapshot"] = v.snapshot_json
    return out


def definition_dict(session: Session, d: Definition, with_versions: bool = True) -> dict:
    current = session.get(Version, d.current_version_id) if d.current_version_id else None
    out = {
        "id": d.id,
        "key": d.key,
        "name": d.name,
        "category": d.category,
        "description": d.description,
        "status": d.status,
        "currentVersion": current.version if current else None,
        "currentVersionId": d.current_version_id,
        "draftRev": d.draft_rev,
    }
    if with_versions:
        versions = session.execute(
            select(Version).where(Version.definition_id == d.id).order_by(Version.version.desc())
        ).scalars()
        out["versions"] = [version_dict(v) for v in versions]
    return out


def _snapshot_of(session: Session, inst: Instance) -> Snapshot:
    v = session.get(Version, inst.version_id)
    return Snapshot(v.snapshot_json if v else {})


def node_label(snap: Snapshot, node_id: str) -> str:
    n = snap.node(node_id) or {}
    return n.get("name") or node_id


def instance_dict(session: Session, inst: Instance, detail: bool = False) -> dict:
    snap = _snapshot_of(session, inst)
    version = session.get(Version, inst.version_id)
    initiator = session.get(User, inst.initiator)
    out = {
        "id": inst.id,
        "definitionKey": inst.definition_key,
        "definitionName": snap.name,
        "version": version.version if version else None,
        "businessKey": inst.business_key,
        "title": inst.title,
        "initiator": inst.initiator,
        "initiatorName": initiator.name if initiator else inst.initiator,
        "status": inst.status,
        "outcome": inst.outcome,
        "createdAt": iso(inst.created_at),
        "startedAt": iso(inst.started_at),
        "endedAt": iso(inst.ended_at),
    }

    tasks = list(
        session.execute(select(Task).where(Task.instance_id == inst.id).order_by(Task.id)).scalars()
    )
    out["openTasks"] = [task_dict(session, t, snap, inst) for t in tasks if t.status in ("CREATED", "CLAIMED")]

    waiting = list(
        session.execute(
            select(Token).where(Token.instance_id == inst.id, Token.status == "WAITING")
        ).scalars()
    )
    current: dict[str, dict] = {}
    for t in waiting:
        node = snap.node(t.node_id) or {}
        if node.get("type") in ("start", "end", "parallel_gateway", "exclusive_gateway", "script"):
            continue  # 网关/脚本上的等待令牌是引擎内部状态，不是"人"在等
        entry = current.setdefault(t.node_id, {"nodeId": t.node_id, "nodeName": node_label(snap, t.node_id), "assignees": []})
        for task in tasks:
            if task.node_id == t.node_id and task.status in ("CREATED", "CLAIMED"):
                u = session.get(User, task.assignee)
                entry["assignees"].append(u.name if u else task.assignee)
    out["currentNodes"] = list(current.values())

    if detail:
        out["variables"] = mask_vars(snap.data, process_vars(session, inst.id))
        out["tasks"] = [task_dict(session, t, snap, inst) for t in tasks]
        out["timeline"] = timeline(session, inst, snap, tasks)
    return out


def task_dict(session: Session, t: Task, snap: Snapshot | None, inst: Instance | None) -> dict:
    u = session.get(User, t.assignee)
    out = {
        "id": t.id,
        "instanceId": t.instance_id,
        "nodeId": t.node_id,
        "nodeName": node_label(snap, t.node_id) if snap else t.node_id,
        "kind": t.kind,
        "assignee": t.assignee,
        "assigneeName": u.name if u else t.assignee,
        "status": t.status,
        "verdict": t.verdict,
        "comment": t.comment,
        "createdAt": iso(t.created_at),
        "claimedAt": iso(t.claimed_at),
        "completedAt": iso(t.completed_at),
    }
    if inst:
        out["businessKey"] = inst.business_key
        out["title"] = inst.title
        out["definitionKey"] = inst.definition_key
        out["instanceStatus"] = inst.status
    return out


def timeline(session: Session, inst: Instance, snap: Snapshot, tasks: list[Task]) -> list[dict]:
    items: list[dict] = []
    audits = session.execute(
        select(AuditLog).where(AuditLog.instance_id == inst.id).order_by(AuditLog.id)
    ).scalars()
    for a in audits:
        items.append(
            {
                "at": iso(a.created_at),
                "kind": "audit",
                "action": a.action,
                "actor": a.actor,
                "detail": a.detail_json,
                "nodeInstanceId": a.node_instance_id,
            }
        )
    vlogs = session.execute(
        select(VariableLog).where(VariableLog.instance_id == inst.id).order_by(VariableLog.id)
    ).scalars()
    for v in vlogs:
        items.append(
            {
                "at": iso(v.created_at),
                "kind": "variable",
                "action": f"变量 {v.name}",
                "actor": v.actor,
                "detail": {"old": v.old_value, "new": v.new_value, "actorType": v.actor_type},
                "nodeInstanceId": v.node_instance_id,
            }
        )
    for t in tasks:
        items.append(
            {
                "at": iso(t.created_at),
                "kind": "task",
                "action": f"任务（{node_label(snap, t.node_id)}）",
                "actor": t.assignee,
                "detail": {"status": t.status, "verdict": t.verdict, "comment": t.comment, "taskId": t.id},
            }
        )
    items.sort(key=lambda x: x["at"] or "")
    return items


def node_instance_dict(ni: NodeInstance, snap: Snapshot) -> dict:
    return {
        "id": ni.id,
        "nodeId": ni.node_id,
        "nodeName": node_label(snap, ni.node_id),
        "nodeType": ni.node_type,
        "status": ni.status,
        "activationSeq": ni.activation_seq,
        "result": ni.result_json,
        "error": ni.error,
        "startedAt": iso(ni.started_at),
        "endedAt": iso(ni.ended_at),
    }
