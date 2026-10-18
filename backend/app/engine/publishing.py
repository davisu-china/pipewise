"""发布流程（PRD §6.3 / 技术方案 §5）。

- 草稿 → 版本快照（不可变），版本号单调递增；
- 发布前跑结构/脚本/表单/表达式校验，任何 error 阻断；
- 发布时把节点上的 `formRef + fieldPermissions` 物化到 wf_form_binding。
"""

from __future__ import annotations

import copy
from datetime import datetime, timezone

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..models import AuditLog, Definition, FormBinding, Version
from . import forms as forms_engine
from .errors import ApiError
from .graph import auto_layout, validate_snapshot


def validate_definition(session: Session, snapshot: dict) -> list[dict]:
    return validate_snapshot(snapshot or {}, forms_engine.published_form_schemas(session))


def _next_version_no(session: Session, definition_id: int) -> int:
    current = session.execute(
        select(func.max(Version.version)).where(Version.definition_id == definition_id)
    ).scalar_one()
    return int(current or 0) + 1


def create_version(session: Session, definition: Definition, actor_id: str, publish: bool) -> Version:
    snapshot = copy.deepcopy(definition.draft_json or {})
    if not snapshot:
        raise ApiError(400, "EMPTY_DRAFT", "草稿为空，先保存流程定义")
    snapshot["key"] = definition.key

    issues = validate_definition(session, snapshot)
    errors = [i for i in issues if i["level"] == "error"]
    if errors:
        raise ApiError(400, "VALIDATION_FAILED", "流程定义校验未通过", {"issues": issues})

    auto_layout(snapshot)
    version_no = _next_version_no(session, definition.id)
    snapshot["version"] = version_no

    version = Version(
        definition_id=definition.id,
        version=version_no,
        snapshot_json=snapshot,
        status="PUBLISHED" if publish else "SUBMITTED",
        submitted_by=actor_id,
        submitted_at=None if publish else datetime.now(timezone.utc),
        published_by=actor_id if publish else None,
        published_at=datetime.now(timezone.utc) if publish else None,
    )
    session.add(version)
    session.flush()

    # 物化表单绑定（快照仍是权威；这张表给运维查询用）
    for node in snapshot.get("nodes", []):
        ref = node.get("formRef")
        if not ref:
            continue
        fv = forms_engine.get_published_form(session, ref)
        if fv is None:
            raise ApiError(400, "FORM_NOT_PUBLISHED", f"节点 {node.get('id')} 引用的表单 {ref} 没有已发布版本")
        session.add(
            FormBinding(
                version_id=version.id,
                node_id=node["id"],
                form_version_id=fv.id,
                field_permissions_json=node.get("fieldPermissions") or {},
            )
        )

    if publish:
        definition.current_version_id = version.id
        definition.status = "active"
    session.add(
        AuditLog(
            instance_id=None,
            action="definition.published" if publish else "definition.submitted",
            actor=actor_id,
            detail_json={"definition": definition.key, "version": version_no},
        )
    )
    session.flush()
    return version


def publish_latest_submitted(session: Session, definition: Definition, actor_id: str) -> Version:
    submitted = session.execute(
        select(Version)
        .where(Version.definition_id == definition.id, Version.status == "SUBMITTED")
        .order_by(Version.version.desc())
        .limit(1)
    ).scalar_one_or_none()
    if submitted is None:
        return create_version(session, definition, actor_id, publish=True)
    submitted.status = "PUBLISHED"
    submitted.published_by = actor_id
    submitted.published_at = datetime.now(timezone.utc)
    definition.current_version_id = submitted.id
    definition.status = "active"
    session.add(
        AuditLog(
            instance_id=None,
            action="definition.published",
            actor=actor_id,
            detail_json={"definition": definition.key, "version": submitted.version},
        )
    )
    session.flush()
    return submitted
