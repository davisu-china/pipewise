"""审批人解析器（PRD §8.5）。

`assignee` 是运行期求值的配置，不是静态名单。解析为空时不静默通过——
由节点的 `emptyPolicy` 决定（默认指派给管理员），见技术方案 §7。
"""

from __future__ import annotations

from sqlalchemy import select
from sqlalchemy.orm import Session

from ..models import Dept, Instance, User
from .expr import ExprError, evaluate


def resolve_assignees(session: Session, cfg: dict | None, instance: Instance, ctx: dict) -> list[str]:
    if not cfg:
        return []
    kind = (cfg.get("type") or "").strip()
    ids: list[str] = []

    if kind == "user":
        ids = _as_list(cfg.get("id") or cfg.get("value"))

    elif kind == "role":
        code = cfg.get("code") or cfg.get("value")
        if code:
            users = session.execute(select(User).where(User.active.is_(True))).scalars()
            ids = [u.id for u in users if code in (u.roles or [])]

    elif kind == "managerOf":
        level = int(cfg.get("level") or 1)
        subject = cfg.get("of") or "initiator"
        uid = _subject_id(session, instance, ctx, subject)
        ids = _walk_manager(session, uid, level)

    elif kind == "deptLeader":
        subject = cfg.get("of") or None
        dept_id = None
        if subject:
            sid = _subject_id(session, instance, ctx, subject)
            u = session.get(User, sid)
            dept_id = u.dept_id if u else None
        else:
            u = session.get(User, instance.initiator)
            dept_id = u.dept_id if u else None
        if dept_id:
            d = session.get(Dept, dept_id)
            if d and d.leader_id:
                ids = [d.leader_id]

    elif kind == "initiator":
        ids = [instance.initiator]

    elif kind == "expr":
        expr = cfg.get("expr") or ""
        try:
            val = evaluate(expr, ctx, extra={"initiator": instance.initiator})
        except ExprError:
            return []
        ids = _as_list(val)

    elif kind == "script":
        # PRD 列为内置解析器之一，但依赖脚本沙箱的返回值；MVP 只支持上面几种
        return []

    # 去重 + 过滤停用账号
    out: list[str] = []
    for uid in ids:
        if not uid:
            continue
        uid = str(uid)
        if uid in out:
            continue
        u = session.get(User, uid)
        if u and not u.active:
            continue
        out.append(uid)
    return out


def _as_list(value) -> list[str]:
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(v) for v in value if v]
    return [str(value)]


def _subject_id(session: Session, instance: Instance, ctx: dict, subject: str) -> str | None:
    if subject == "initiator":
        return instance.initiator
    # 变量名或表达式
    if subject in ctx:
        return str(ctx[subject]) if ctx[subject] is not None else None
    try:
        val = evaluate(subject, ctx, extra={"initiator": instance.initiator})
        return str(val) if val is not None else None
    except ExprError:
        return None


def _walk_manager(session: Session, uid: str | None, level: int) -> list[str]:
    if not uid:
        return []
    cur = session.get(User, uid)
    seen: set[str] = set()
    for _ in range(max(0, level)):
        if not cur or not cur.manager_id:
            return []
        if cur.manager_id in seen:
            return []
        seen.add(cur.manager_id)
        cur = session.get(User, cur.manager_id)
    if not cur or cur.id == uid:
        return []
    return [cur.id]
