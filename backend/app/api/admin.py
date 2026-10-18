"""运维与平台管理接口（PRD §12.3 / §14.4）。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Query
from pydantic import BaseModel, Field
from sqlalchemy import func, select
from sqlalchemy.orm import Session

from ..db import get_session
from ..engine.engine import engine
from ..engine.errors import not_found
from ..models import DevSink, Instance, Outbox, Task, User, Webhook
from .deps import require_roles
from .serializers import instance_dict

router = APIRouter(prefix="/admin", tags=["admin"])


class ForceBody(BaseModel):
    verdict: str = "approve"
    comment: str | None = None


class SetVarBody(BaseModel):
    name: str
    value: object = None


class WebhookBody(BaseModel):
    url: str
    secret: str = ""
    definitionKey: str | None = None


@router.post("/tasks/{task_id}/force-complete")
def force_complete(
    task_id: int,
    body: ForceBody,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    engine.force_complete_task(session, task_id, user.id, body.verdict, body.comment)
    return {"ok": True}


@router.post("/instances/{iid}/set-variable")
def set_variable(
    iid: int,
    body: SetVarBody,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    engine.set_variable(session, iid, body.name, body.value, user.id)
    return {"ok": True}


@router.post("/instances/{iid}/retry")
def retry(
    iid: int,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    engine.retry_failed(session, iid, user.id)
    return {"ok": True}


@router.get("/outbox")
def list_outbox(
    status: str | None = None,
    limit: int = Query(default=100, le=500),
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    q = select(Outbox)
    if status:
        q = q.where(Outbox.status == status)
    rows = session.execute(q.order_by(Outbox.id.desc()).limit(limit)).scalars()
    return {
        "items": [
            {
                "id": r.id,
                "instanceId": r.instance_id,
                "type": r.type,
                "status": r.status,
                "attempts": r.attempts,
                "nextRetryAt": r.next_retry_at.isoformat() if r.next_retry_at else None,
                "createdAt": r.created_at.isoformat() if r.created_at else None,
                "deliveredAt": r.delivered_at.isoformat() if r.delivered_at else None,
                "payload": r.payload_json,
            }
            for r in rows
        ]
    }


@router.get("/stats")
def stats(
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    by_status = dict(
        session.execute(
            select(Instance.status, func.count(Instance.id)).where(Instance.dry_run.is_(False)).group_by(Instance.status)
        ).all()
    )
    open_tasks = session.execute(
        select(func.count(Task.id)).where(Task.status.in_(("CREATED", "CLAIMED")))
    ).scalar_one()
    pending_outbox = session.execute(
        select(func.count(Outbox.id)).where(Outbox.status == "PENDING")
    ).scalar_one()
    dead_outbox = session.execute(
        select(func.count(Outbox.id)).where(Outbox.status == "DEAD")
    ).scalar_one()
    by_definition = [
        {"definitionKey": k, "total": n, "running": r}
        for k, n, r in session.execute(
            select(
                Instance.definition_key,
                func.count(Instance.id),
                func.count(Instance.id).filter(Instance.status == "RUNNING"),
            )
            .where(Instance.dry_run.is_(False))
            .group_by(Instance.definition_key)
        ).all()
    ]
    failed = session.execute(
        select(Instance).where(Instance.status == "FAILED", Instance.dry_run.is_(False)).order_by(Instance.id.desc()).limit(20)
    ).scalars()
    return {
        "instancesByStatus": by_status,
        "openTasks": open_tasks,
        "outboxPending": pending_outbox,
        "outboxDead": dead_outbox,
        "byDefinition": by_definition,
        "failedInstances": [instance_dict(session, i) for i in failed],
    }


@router.get("/webhooks")
def list_webhooks(
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    rows = session.execute(select(Webhook).order_by(Webhook.id)).scalars()
    return {
        "items": [
            {"id": w.id, "url": w.url, "secret": bool(w.secret), "definitionKey": w.definition_key, "enabled": w.enabled}
            for w in rows
        ]
    }


@router.post("/webhooks")
def create_webhook(
    body: WebhookBody,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    w = Webhook(url=body.url, secret=body.secret, definition_key=body.definitionKey)
    session.add(w)
    session.flush()
    return {"id": w.id}


@router.delete("/webhooks/{wid}")
def delete_webhook(
    wid: int,
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    w = session.get(Webhook, wid)
    if w is None:
        raise not_found("webhook")
    session.delete(w)
    return {"ok": True}


@router.get("/dev-sink")
def dev_sink(
    limit: int = Query(default=50, le=200),
    session: Session = Depends(get_session),
    user: User = Depends(require_roles("admin")),
):
    rows = session.execute(select(DevSink).order_by(DevSink.id.desc()).limit(limit)).scalars()
    return {
        "items": [
            {
                "id": r.id,
                "eventType": r.event_type,
                "payload": r.payload_json,
                "signature": r.signature,
                "receivedAt": r.received_at.isoformat() if r.received_at else None,
            }
            for r in rows
        ]
    }
