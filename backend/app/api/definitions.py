"""流程定义与发布相关接口。"""

from __future__ import annotations

from fastapi import APIRouter, Depends
from pydantic import BaseModel, Field
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_session, SessionLocal
from ..engine import forms as forms_engine
from ..engine.errors import ApiError, not_found
from ..engine.publishing import create_version, publish_latest_submitted, validate_definition
from ..models import Definition, Instance, NodeInstance, Task, Version
from .deps import current_user, require_roles
from .serializers import definition_dict, version_dict
from ..models import User

router = APIRouter(prefix="/definitions", tags=["definitions"])

EMPTY_SNAPSHOT = {
    "key": "",
    "name": "",
    "variables": [],
    "nodes": [
        {"id": "start", "type": "start", "name": "开始", "position": {"x": 400, "y": 80}},
        {"id": "end", "type": "end", "name": "结束", "position": {"x": 400, "y": 320}},
    ],
    "edges": [{"id": "e1", "from": "start", "to": "end"}],
}


class CreateDefinitionBody(BaseModel):
    key: str = Field(min_length=2, max_length=128, pattern=r"^[a-z][a-z0-9_]*$")
    name: str
    category: str | None = None
    description: str | None = None


class SaveDraftBody(BaseModel):
    snapshot: dict
    rev: int | None = None


class SnapshotBody(BaseModel):
    snapshot: dict | None = None


class DryRunBody(BaseModel):
    variables: dict = Field(default_factory=dict)
    autoVerdict: str = "approve"


def _get_definition(session: Session, key: str) -> Definition:
    d = session.execute(select(Definition).where(Definition.key == key)).scalar_one_or_none()
    if d is None:
        raise not_found("流程定义")
    return d


@router.get("")
def list_definitions(
    session: Session = Depends(get_session), user: User = Depends(current_user)
):
    defs = session.execute(select(Definition).order_by(Definition.id)).scalars()
    out = []
    for d in defs:
        item = definition_dict(session, d, with_versions=False)
        snap = d.draft_json or {}
        item["startableBy"] = snap.get("startableBy") or []
        item["canStart"] = not item["startableBy"] or "admin" in (user.roles or []) or any(
            r in (user.roles or []) for r in item["startableBy"]
        )
        out.append(item)
    return {"items": out}


@router.post("")
def create_definition(
    body: CreateDefinitionBody,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("designer")),
):
    if session.execute(select(Definition).where(Definition.key == body.key)).scalar_one_or_none():
        raise ApiError(409, "KEY_TAKEN", f"定义 key 已存在：{body.key}")
    snapshot = {**EMPTY_SNAPSHOT, "key": body.key, "name": body.name}
    d = Definition(
        key=body.key,
        name=body.name,
        category=body.category,
        description=body.description,
        draft_json=snapshot,
        draft_rev=1,
        created_by=user.id,
    )
    session.add(d)
    session.flush()
    return definition_dict(session, d)


@router.get("/{key}")
def get_definition(
    key: str,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    d = _get_definition(session, key)
    out = definition_dict(session, d)
    out["draft"] = d.draft_json
    return out


@router.put("/{key}/draft")
def save_draft(
    key: str,
    body: SaveDraftBody,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("designer")),
):
    d = _get_definition(session, key)
    if body.rev is not None and body.rev != d.draft_rev:
        raise ApiError(409, "DRAFT_CONFLICT", "草稿已被其他人修改，请刷新后再保存", {"rev": d.draft_rev})
    snapshot = body.snapshot or {}
    snapshot["key"] = key
    d.draft_json = snapshot
    d.draft_rev += 1
    session.flush()
    return {"rev": d.draft_rev, "issues": validate_definition(session, snapshot)}


@router.post("/{key}/validate")
def validate(
    key: str,
    body: SnapshotBody,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("designer")),
):
    d = _get_definition(session, key)
    snapshot = body.snapshot or d.draft_json
    return {"issues": validate_definition(session, snapshot)}


@router.post("/{key}/dry-run")
def dry_run(
    key: str,
    body: DryRunBody,
    user: User = Depends(require_roles("designer")),
):
    """试跑：在一个**会回滚**的事务里真跑一遍，返回路径轨迹（技术方案 §5）。"""
    session = SessionLocal()
    try:
        d = _get_definition(session, key)
        if not d.current_version_id:
            raise ApiError(400, "NO_VERSION", "该流程还没有已发布版本，先发布再试跑")
        version = session.get(Version, d.current_version_id)
        from ..engine.engine import engine

        inst, _ = engine.create_instance(
            session,
            definition=d,
            version=version,
            business_key=f"__dryrun__{os_pid()}_{inst_seq()}",
            initiator=user.id,
            title="[试跑]",
            variables=body.variables,
            actor=user.id,
            dry_run=True,
        )
        steps = 0
        while steps < 200:
            task = session.execute(
                select(Task)
                .where(Task.instance_id == inst.id, Task.status.in_(("CREATED", "CLAIMED")))
                .order_by(Task.id)
            ).scalars().first()
            if task is None:
                break
            engine.complete_task(
                session,
                task.id,
                user.id,
                verdict=body.autoVerdict if body.autoVerdict in ("approve", "reject") else "approve",
                comment="[试跑] 自动处理",
                actor_type="admin",
            )
            steps += 1
            if inst.status != "RUNNING":
                break

        snap_db = session.get(Version, inst.version_id)
        from ..engine.graph import Snapshot

        snap = Snapshot(snap_db.snapshot_json)
        nis = session.execute(
            select(NodeInstance)
            .where(NodeInstance.instance_id == inst.id)
            .order_by(NodeInstance.id)
            .execution_options(populate_existing=True)
        ).scalars().all()
        trace = [
            {
                "nodeId": ni.node_id,
                "nodeName": (snap.node(ni.node_id) or {}).get("name") or ni.node_id,
                "nodeType": ni.node_type,
                "status": ni.status,
                "activationSeq": ni.activation_seq,
                "result": ni.result_json,
                "error": ni.error,
            }
            for ni in nis
        ]
        from ..engine.context import mask_vars, process_vars

        return {
            "ok": True,
            "finished": inst.status == "COMPLETED",
            "status": inst.status,
            "outcome": inst.outcome,
            "steps": steps,
            "trace": trace,
            "variables": mask_vars(snap_db.snapshot_json, process_vars(session, inst.id)),
        }
    finally:
        session.rollback()
        session.close()


def os_pid() -> int:
    import os

    return os.getpid()


_dryrun_counter = 0


def inst_seq() -> int:
    global _dryrun_counter
    _dryrun_counter += 1
    return _dryrun_counter


@router.post("/{key}/submit")
def submit_definition(
    key: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("designer")),
):
    d = _get_definition(session, key)
    v = create_version(session, d, user.id, publish=False)
    return version_dict(v)


@router.post("/{key}/publish")
def publish_definition(
    key: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    d = _get_definition(session, key)
    v = publish_latest_submitted(session, d, user.id)
    return version_dict(v)


@router.post("/{key}/retire")
def retire_definition(
    key: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    d = _get_definition(session, key)
    d.status = "retired"
    session.flush()
    return {"key": d.key, "status": d.status}


@router.get("/{key}/versions")
def list_versions(
    key: str,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    d = _get_definition(session, key)
    versions = session.execute(
        select(Version).where(Version.definition_id == d.id).order_by(Version.version.desc())
    ).scalars()
    return {"items": [version_dict(v) for v in versions]}


@router.get("/{key}/versions/{no}")
def get_version(
    key: str,
    no: int,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    d = _get_definition(session, key)
    v = session.execute(
        select(Version).where(Version.definition_id == d.id, Version.version == no)
    ).scalar_one_or_none()
    if v is None:
        raise not_found("版本")
    return version_dict(v, full=True)


@router.get("/{key}/form-schemas")
def form_schemas(
    key: str,
    session: Session = Depends(get_session),
    user: User = Depends(current_user),
):
    """设计器用：所有已发布表单的 schema（配置字段权限时选字段）。"""
    return {"items": forms_engine.published_form_schemas(session)}
