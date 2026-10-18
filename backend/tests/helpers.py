"""测试辅助：直接驱动引擎（比走 HTTP 更快、更精确）。"""

from __future__ import annotations

import uuid

from sqlalchemy import select
from sqlalchemy.orm import Session

from app.engine.engine import engine
from app.engine.errors import ApiError
from app.engine.publishing import create_version
from app.models import Definition, Instance, Task, Version


def publish_flow(session: Session, key: str, snapshot: dict) -> Definition:
    existing = session.execute(select(Definition).where(Definition.key == key)).scalar_one_or_none()
    if existing:
        return existing
    snap = {**snapshot, "key": key, "name": snapshot.get("name") or key}
    d = Definition(key=key, name=snap["name"], draft_json=snap, draft_rev=1, created_by="u_designer")
    session.add(d)
    session.flush()
    create_version(session, d, "u_admin", publish=True)
    session.flush()
    return d


def make_instance(session: Session, key: str, variables: dict, initiator="u_zhangsan", business_key: str | None = None) -> Instance:
    d = session.execute(select(Definition).where(Definition.key == key)).scalar_one()
    version = session.get(Version, d.current_version_id)
    inst, _ = engine.create_instance(
        session,
        definition=d,
        version=version,
        business_key=business_key or f"T-{uuid.uuid4().hex[:10]}",
        initiator=initiator,
        title="测试",
        variables=variables,
        actor=initiator,
    )
    session.flush()
    return inst


def open_tasks(session: Session, inst: Instance, assignee: str | None = None) -> list[Task]:
    q = select(Task).where(Task.instance_id == inst.id, Task.status.in_(("CREATED", "CLAIMED")))
    if assignee:
        q = q.where(Task.assignee == assignee)
    return list(session.execute(q.order_by(Task.id).execution_options(populate_existing=True)).scalars())


def do(session: Session, task: Task, actor: str | None = None, verdict: str = "approve", data: dict | None = None, comment: str | None = None):
    return engine.complete_task(
        session, task.id, actor or task.assignee, verdict=verdict, comment=comment, submitted=data
    )


def reload(session: Session, inst: Instance) -> Instance:
    session.expire_all()
    return session.get(Instance, inst.id)


def expect_error(fn, code: str):
    try:
        fn()
    except ApiError as e:
        assert e.code == code, f"期望 {code}，实际 {e.code}: {e.message}"
        return e
    raise AssertionError(f"期望抛出 {code}，但没抛")
