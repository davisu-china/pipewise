"""表单资产接口（表单设计器/发布）。"""

from __future__ import annotations

from datetime import datetime, timezone

from fastapi import APIRouter, Depends
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from ..db import get_session
from ..engine.errors import ApiError, not_found
from ..models import Form, FormVersion, User
from .deps import current_user, require_roles

router = APIRouter(prefix="/forms", tags=["forms"])


class FormBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    key: str = Field(min_length=2, max_length=128, pattern=r"^[a-z][a-z0-9_]*$")
    name: str
    category: str | None = None
    form_schema: dict = Field(default_factory=dict, alias="schema")


class FormDraftBody(BaseModel):
    model_config = ConfigDict(populate_by_name=True)

    form_schema: dict = Field(alias="schema")
    rev: int | None = None


def _get_form(session: Session, key: str) -> Form:
    f = session.execute(select(Form).where(Form.key == key)).scalar_one_or_none()
    if f is None:
        raise not_found("表单")
    return f


def _latest_published(session: Session, form_id: int) -> FormVersion | None:
    return session.execute(
        select(FormVersion)
        .where(FormVersion.form_id == form_id, FormVersion.status == "PUBLISHED")
        .order_by(desc(FormVersion.version))
        .limit(1)
    ).scalar_one_or_none()


def _form_dict(session: Session, f: Form) -> dict:
    pub = _latest_published(session, f.id)
    return {
        "id": f.id,
        "key": f.key,
        "name": f.name,
        "category": f.category,
        "draftSchema": f.draft_schema,
        "draftRev": f.draft_rev,
        "published": {"version": pub.version, "schema": pub.schema_json} if pub else None,
    }


@router.get("")
def list_forms(session: Session = Depends(get_session), user: User = Depends(current_user)):
    return {"items": [_form_dict(session, f) for f in session.execute(select(Form).order_by(Form.id)).scalars()]}


@router.post("")
def create_form(
    body: FormBody,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("designer")),
):
    if session.execute(select(Form).where(Form.key == body.key)).scalar_one_or_none():
        raise ApiError(409, "KEY_TAKEN", f"表单 key 已存在：{body.key}")
    schema = {**body.form_schema, "key": body.key, "name": body.name}
    f = Form(key=body.key, name=body.name, category=body.category, draft_schema=schema, draft_rev=1)
    session.add(f)
    session.flush()
    return _form_dict(session, f)


@router.get("/{key}")
def get_form(key: str, session: Session = Depends(get_session), user: User = Depends(current_user)):
    f = _get_form(session, key)
    out = _form_dict(session, f)
    versions = session.execute(
        select(FormVersion).where(FormVersion.form_id == f.id).order_by(FormVersion.version.desc())
    ).scalars()
    out["versions"] = [
        {"id": v.id, "version": v.version, "status": v.status, "publishedAt": v.published_at.isoformat() if v.published_at else None}
        for v in versions
    ]
    return out


@router.put("/{key}/draft")
def save_form_draft(
    key: str,
    body: FormDraftBody,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("designer")),
):
    f = _get_form(session, key)
    if body.rev is not None and body.rev != f.draft_rev:
        raise ApiError(409, "DRAFT_CONFLICT", "表单草稿已被修改，请刷新", {"rev": f.draft_rev})
    schema = body.form_schema or {}
    schema["key"] = key
    schema.setdefault("name", f.name)
    f.draft_schema = schema
    f.draft_rev += 1
    session.flush()
    return {"rev": f.draft_rev}


@router.post("/{key}/publish")
def publish_form(
    key: str,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    f = _get_form(session, key)
    schema = f.draft_schema or {}
    if not schema.get("fields"):
        raise ApiError(400, "EMPTY_FORM", "表单还没有字段")
    names = set()
    for field in schema["fields"]:
        name = field.get("name")
        if field.get("type") == "static":
            continue
        if not name:
            raise ApiError(400, "FIELD_NO_NAME", "字段缺少 name")
        if name in names:
            raise ApiError(400, "FIELD_DUP", f"字段 name 重复：{name}")
        names.add(name)
    pub = _latest_published(session, f.id)
    version_no = (pub.version + 1) if pub else 1
    schema["version"] = version_no
    v = FormVersion(
        form_id=f.id,
        version=version_no,
        schema_json=schema,
        status="PUBLISHED",
        published_by=user.id,
        published_at=datetime.now(timezone.utc),
    )
    session.add(v)
    session.flush()
    return {"key": key, "version": version_no}
