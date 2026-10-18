"""待办与任务动作接口（同意/否决/转交/加签/催办）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..db import get_session
from ..engine import forms as forms_engine
from ..engine.context import process_vars
from ..engine.engine import engine
from ..engine.errors import ApiError, conflict, forbidden, not_found
from ..engine.graph import Snapshot
from ..models import Instance, Task, User, Version
from .deps import current_user
from .serializers import task_dict

router = APIRouter(prefix="/tasks", tags=["tasks"])


class CompleteBody(BaseModel):
    verdict: str = "approve"
    comment: str | None = None


class SubmitFormBody(BaseModel):
    data: dict = Field(default_factory=dict)
    verdict: str | None = None
    comment: str | None = None


class DelegateBody(BaseModel):
    to: str


class AddSignBody(BaseModel):
    users: list[str]


class RemindBody(BaseModel):
    message: str | None = None


def _load(session: Session, task_id: int) -> tuple[Task, Instance, Snapshot, dict]:
    task = session.get(Task, task_id)
    if task is None:
        raise not_found("任务")
    inst = session.get(Instance, task.instance_id)
    if inst is None:
        raise not_found("实例")
    version = session.get(Version, inst.version_id)
    snap = Snapshot(version.snapshot_json if version else {})
    return task, inst, snap, snap.node(task.node_id) or {}


@router.get("")
def list_tasks(
    assignee: str = Query(default="me"),
    status: str = Query(default="pending"),
    instance_id: int | None = Query(default=None, alias="instanceId"),
    limit: int = Query(default=100, le=500),
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    q = select(Task)
    if assignee == "me":
        q = q.where(Task.assignee == user.id)
    else:
        if "admin" not in (user.roles or []):
            raise forbidden("只有管理员可以按他人筛选")
        q = q.where(Task.assignee == assignee)
    if status == "pending":
        q = q.where(Task.status.in_(("CREATED", "CLAIMED")))
    elif status == "done":
        q = q.where(Task.status == "COMPLETED")
    elif status != "all":
        raise ApiError(400, "BAD_STATUS", "status 只支持 pending/done/all")
    if instance_id:
        q = q.where(Task.instance_id == instance_id)
    rows = session.execute(q.order_by(Task.id.desc()).limit(limit)).scalars().all()

    snap_cache: dict[int, Snapshot] = {}
    inst_cache: dict[int, Instance] = {}
    out = []
    for t in rows:
        if t.instance_id not in inst_cache:
            inst_cache[t.instance_id] = session.get(Instance, t.instance_id)
        inst = inst_cache[t.instance_id]
        if inst is None:
            continue
        if inst.version_id not in snap_cache:
            v = session.get(Version, inst.version_id)
            snap_cache[inst.version_id] = Snapshot(v.snapshot_json if v else {})
        out.append(task_dict(session, t, snap_cache[inst.version_id], inst))
    return {"items": out}


@router.get("/{task_id}/form")
def task_form(
    task_id: int,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    task, inst, snap, node = _load(session, task_id)
    if task.assignee != user.id and "admin" not in (user.roles or []):
        raise forbidden("这条任务不是指派给你的")
    schema = engine._form_schema_for(session, inst, node)
    if schema is None:
        return {"form": None, "nodeId": node.get("id"), "nodeName": node.get("name")}
    payload = forms_engine.build_form_payload(node, schema, process_vars(session, inst.id))
    return {
        "form": payload,
        "nodeId": node.get("id"),
        "nodeName": node.get("name"),
        "nodeType": node.get("type"),
        "signMode": node.get("signMode") or ("first" if node.get("type") == "form" else "any"),
        "instance": {"id": inst.id, "status": inst.status, "title": inst.title, "businessKey": inst.business_key},
        "task": task_dict(session, task, snap, inst),
    }


@router.post("/{task_id}/claim")
def claim(
    task_id: int,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    task = session.get(Task, task_id)
    if task is None:
        raise not_found("任务")
    if task.assignee != user.id:
        raise forbidden("这条任务不是指派给你的")
    res = session.execute(
        update(Task)
        .where(Task.id == task_id, Task.status == "CREATED")
        .values(status="CLAIMED")
    )
    if res.rowcount == 0:
        raise conflict("TASK_NOT_CLAIMABLE", "任务状态不允许认领")
    inst = session.get(Instance, task.instance_id)
    engine.audit(session, inst, "task.claimed", user.id, {"task": task.id})
    return {"status": "CLAIMED"}


@router.post("/{task_id}/complete")
def complete(
    task_id: int,
    body: CompleteBody,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    task, inst, snap, node = _load(session, task_id)
    if node.get("formRef"):
        raise ApiError(400, "USE_SUBMIT_FORM", "该节点绑定了表单，请走 submit-form（校验与流转同事务）")
    engine.complete_task(session, task_id, user.id, verdict=body.verdict, comment=body.comment)
    return {"ok": True, "instanceStatus": inst.status}


@router.post("/{task_id}/submit-form")
def submit_form(
    task_id: int,
    body: SubmitFormBody,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    task, inst, snap, node = _load(session, task_id)
    verdict = body.verdict
    if node.get("type") == "approval" and not verdict:
        raise ApiError(400, "VERDICT_REQUIRED", "审批节点需要 verdict（approve/reject）")
    engine.complete_task(
        session,
        task_id,
        user.id,
        verdict=verdict,
        comment=body.comment,
        submitted=body.data,
    )
    return {"ok": True, "instanceStatus": inst.status}


@router.post("/{task_id}/delegate")
def delegate(
    task_id: int,
    body: DelegateBody,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    task, inst, snap, node = _load(session, task_id)
    is_admin = "admin" in (user.roles or [])
    if task.assignee != user.id and not is_admin:
        raise forbidden("只能转交指派给自己的任务")
    target = session.get(User, body.to)
    if target is None or not target.active:
        raise ApiError(400, "TARGET_INVALID", "转交目标不存在或已停用")
    if task.status not in ("CREATED", "CLAIMED"):
        raise conflict("TASK_NOT_OPEN", "任务已结束")
    if task.assignee == target.id:
        return {"ok": True}
    dup = session.execute(
        select(Task.id).where(Task.node_instance_id == task.node_instance_id, Task.assignee == target.id)
    ).first()
    if dup:
        raise conflict("TARGET_HAS_TASK", "对方已经在这个节点上有任务了")
    old = task.assignee
    task.assignee = target.id
    engine.audit(session, inst, "task.delegated", user.id, {"task": task.id, "from": old, "to": target.id})
    engine.emit_event(session, inst, "task.delegated", {"task_id": task.id, "from": old, "to": target.id})
    return {"ok": True, "assignee": target.id}


@router.post("/{task_id}/add-sign")
def add_sign(
    task_id: int,
    body: AddSignBody,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    task, inst, snap, node = _load(session, task_id)
    is_admin = "admin" in (user.roles or [])
    if task.assignee != user.id and not is_admin:
        raise forbidden("只能给自己/管理员加签")
    ni_id = task.node_instance_id
    from ..models import NodeInstance

    ni = session.get(NodeInstance, ni_id)
    if ni is None or ni.status != "WAITING":
        raise conflict("NODE_NOT_WAITING", "节点已经结束，不能再加签")
    added: list[str] = []
    for uid in body.users:
        target = session.get(User, uid)
        if target is None or not target.active:
            raise ApiError(400, "TARGET_INVALID", f"用户不存在或已停用：{uid}")
        dup = session.execute(
            select(Task.id).where(Task.node_instance_id == ni_id, Task.assignee == uid)
        ).first()
        if dup:
            continue
        session.add(
            Task(
                instance_id=inst.id,
                node_instance_id=ni_id,
                node_id=node["id"],
                kind=task.kind,
                assignee=uid,
                status="CREATED",
            )
        )
        added.append(uid)
    session.flush()
    engine.audit(session, inst, "task.add_signed", user.id, {"task": task.id, "users": added})
    if added:
        engine.emit_event(session, inst, "task.created", {"node_id": node["id"], "assignees": added, "addSign": True})
    return {"ok": True, "added": added}


@router.post("/{task_id}/remind")
def remind(
    task_id: int,
    body: RemindBody,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    task, inst, snap, node = _load(session, task_id)
    if inst.initiator != user.id and "admin" not in (user.roles or []):
        raise forbidden("只有发起人或管理员可以催办")
    engine.audit(session, inst, "task.reminded", user.id, {"task": task.id, "message": body.message})
    engine.emit_event(
        session,
        inst,
        "task.reminded",
        {"task_id": task.id, "assignee": task.assignee, "message": body.message},
    )
    return {"ok": True}
