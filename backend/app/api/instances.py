"""实例生命周期与查询接口。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Header, Query
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_session
from ..engine.engine import engine
from ..engine.errors import ApiError, forbidden, not_found
from ..models import Definition, Instance, Task, User, Version
from .deps import current_user, idempotent, require_roles
from .serializers import instance_dict

router = APIRouter(prefix="/instances", tags=["instances"])


class CreateInstanceBody(BaseModel):
    key: str
    businessKey: str = Field(min_length=1, max_length=128)
    title: str | None = None
    variables: dict = Field(default_factory=dict)


class TerminateBody(BaseModel):
    reason: str | None = None


def _get_instance(session: Session, iid: int) -> Instance:
    inst = session.get(Instance, iid)
    if inst is None:
        raise not_found("实例")
    return inst


def _can_view(session: Session, inst: Instance, user: User) -> bool:
    if "admin" in (user.roles or []) or inst.initiator == user.id:
        return True
    if inst.dry_run:
        return False
    n = session.execute(
        select(Task.id).where(Task.instance_id == inst.id, Task.assignee == user.id).limit(1)
    ).first()
    return n is not None


@router.post("")
def create_instance(
    body: CreateInstanceBody,
    idempotency_key: str | None = Header(default=None, alias="Idempotency-Key"),
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    d = session.execute(select(Definition).where(Definition.key == body.key)).scalar_one_or_none()
    if d is None:
        raise not_found("流程定义")
    if d.status != "active":
        raise ApiError(409, "DEFINITION_RETIRED", "该流程已下线，不能发起新实例")
    if not d.current_version_id:
        raise ApiError(409, "NO_VERSION", "该流程没有已发布版本")
    version = session.get(Version, d.current_version_id)
    startable = (d.draft_json or {}).get("startableBy") or []
    if startable and not ("admin" in (user.roles or []) or any(r in (user.roles or []) for r in startable)):
        raise forbidden("你没有发起这个流程的权限")

    def run() -> dict:
        inst, dedup = engine.create_instance(
            session,
            definition=d,
            version=version,
            business_key=body.businessKey,
            initiator=user.id,
            title=body.title,
            variables=body.variables,
            actor=user.id,
        )
        out = instance_dict(session, inst, detail=True)
        out["deduplicated"] = dedup
        return out

    return idempotent(session, f"instance.create:{body.key}", idempotency_key, user, run)


@router.get("")
def list_instances(
    status: str | None = None,
    definition_key: str | None = Query(default=None, alias="definitionKey"),
    business_key: str | None = Query(default=None, alias="businessKey"),
    mine: bool = Query(default=False),
    limit: int = Query(default=50, le=200),
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    q = select(Instance).where(Instance.dry_run.is_(False))
    if status:
        q = q.where(Instance.status == status)
    if definition_key:
        q = q.where(Instance.definition_key == definition_key)
    if business_key:
        q = q.where(Instance.business_key == business_key)
    if mine or "admin" not in (user.roles or []):
        q = q.where(Instance.initiator == user.id)
    rows = session.execute(q.order_by(Instance.id.desc()).limit(limit)).scalars()
    return {"items": [instance_dict(session, i) for i in rows]}


@router.get("/{iid}")
def get_instance(
    iid: int,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    inst = _get_instance(session, iid)
    if not _can_view(session, inst, user):
        raise forbidden("无权查看这个实例")
    out = instance_dict(session, inst, detail=True)
    from ..models import NodeInstance

    snap = engine.snapshot(session, inst)
    nis = session.execute(
        select(NodeInstance)
        .where(NodeInstance.instance_id == inst.id)
        .order_by(NodeInstance.id)
        .execution_options(populate_existing=True)
    ).scalars()
    out["nodeInstances"] = [
        {
            "id": ni.id,
            "nodeId": ni.node_id,
            "nodeName": (snap.node(ni.node_id) or {}).get("name") or ni.node_id,
            "nodeType": ni.node_type,
            "status": ni.status,
            "activationSeq": ni.activation_seq,
            "result": ni.result_json,
            "error": ni.error,
            "startedAt": ni.started_at.isoformat() if ni.started_at else None,
            "endedAt": ni.ended_at.isoformat() if ni.ended_at else None,
        }
        for ni in nis
    ]
    return out


@router.post("/{iid}/suspend")
def suspend(
    iid: int,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    engine.suspend(session, iid, user.id)
    return {"status": "SUSPENDED"}


@router.post("/{iid}/resume")
def resume(
    iid: int,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    engine.resume(session, iid, user.id)
    return {"status": "RUNNING"}


@router.post("/{iid}/terminate")
def terminate(
    iid: int,
    body: TerminateBody,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    engine.terminate(session, iid, user.id, body.reason)
    return {"status": "TERMINATED"}


@router.post("/{iid}/withdraw")
def withdraw(
    iid: int,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    engine.withdraw(session, iid, user.id)
    return {"status": "TERMINATED"}


@router.get("/{iid}/timeline")
def timeline(
    iid: int,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    inst = _get_instance(session, iid)
    if not _can_view(session, inst, user):
        raise forbidden("无权查看这个实例")
    out = instance_dict(session, inst, detail=True)
    return {"items": out["timeline"]}
