"""流程上下文：变量读写、乐观锁、审计（PRD 第 11 章 / 技术方案 §3.10）。

- 流程级变量：`scope='process', node_instance_id=0`
- 节点局部变量：`scope='local', node_instance_id=<id>`
- 写入必须带版本号；版本不匹配抛 VariableConflict（由调用方决定重试/挂起/覆盖）
"""

from __future__ import annotations

from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import select, update
from sqlalchemy.orm import Session

from ..models import Dept, Instance, User, Variable, VariableLog
from .errors import VariableConflict


def process_vars(session: Session, instance_id: int) -> dict[str, Any]:
    rows = session.execute(
        select(Variable).where(
            Variable.instance_id == instance_id,
            Variable.scope == "process",
            Variable.node_instance_id == 0,
        )
    ).scalars()
    return {r.name: r.value_json for r in rows}


def local_vars(session: Session, instance_id: int, node_instance_id: int) -> dict[str, Any]:
    rows = session.execute(
        select(Variable).where(
            Variable.instance_id == instance_id,
            Variable.scope == "local",
            Variable.node_instance_id == node_instance_id,
        )
    ).scalars()
    return {r.name: r.value_json for r in rows}


def _update_with_version(
    session: Session,
    instance_id: int,
    scope: str,
    node_instance_id: int,
    name: str,
    value: Any,
    var_type: str,
    conflict_mode: str,
) -> tuple[Any, int]:
    """返回 (旧值, 新版本号)。冲突按 conflict_mode 处理。"""
    row = session.execute(
        select(Variable).where(
            Variable.instance_id == instance_id,
            Variable.scope == scope,
            Variable.node_instance_id == node_instance_id,
            Variable.name == name,
        )
    ).scalar_one_or_none()

    if row is None:
        session.add(
            Variable(
                instance_id=instance_id,
                scope=scope,
                node_instance_id=node_instance_id,
                name=name,
                type=var_type,
                value_json=value,
                version=1,
            )
        )
        session.flush()
        return None, 1

    old = row.value_json
    expected = row.version
    result = session.execute(
        update(Variable)
        .where(Variable.id == row.id, Variable.version == expected)
        .values(value_json=value, version=expected + 1, type=var_type)
    )
    if result.rowcount == 0:
        # 冲突：retry 会读一次新版本再试一次；last_write_wins 直接覆盖；fail 抛给调用方
        session.expire(row)
        fresh = session.get(Variable, row.id)
        if fresh is None:
            raise VariableConflict(name, expected, expected + 1)
        if conflict_mode in ("retry", "last_write_wins"):
            retry_expected = fresh.version
            result = session.execute(
                update(Variable)
                .where(Variable.id == row.id, Variable.version == retry_expected)
                .values(value_json=value, version=retry_expected + 1, type=var_type)
            )
            if result.rowcount > 0:
                session.flush()
                return old, retry_expected + 1
            if conflict_mode == "retry":
                session.expire(fresh)
                again = session.get(Variable, row.id)
                raise VariableConflict(name, expected, again.version if again else retry_expected + 1)
            session.execute(
                update(Variable).where(Variable.id == row.id).values(value_json=value, version=Variable.version + 1, type=var_type)
            )
            session.flush()
            return old, fresh.version + 1
        raise VariableConflict(name, expected, fresh.version)
    session.flush()
    return old, expected + 1


def write_vars(
    session: Session,
    instance: Instance,
    updates: dict[str, Any],
    actor: str,
    actor_type: str,
    node_instance_id: int = 0,
    scope: str = "process",
    conflict_mode: str = "fail",
    sensitive_names: set[str] | None = None,
    audit_node_instance_id: int | None = None,
) -> list[str]:
    """批量写变量 + 落审计。返回真正写入的变量名。"""
    sensitive_names = sensitive_names or set()
    written: list[str] = []
    for name, value in updates.items():
        var_type = _guess_type(value)
        old, new_version = _update_with_version(
            session, instance.id, scope, node_instance_id, name, value, var_type, conflict_mode
        )
        mask = name in sensitive_names
        session.add(
            VariableLog(
                instance_id=instance.id,
                node_instance_id=node_instance_id if audit_node_instance_id is None else audit_node_instance_id,
                name=name,
                old_value="***" if mask else old,
                new_value="***" if mask else value,
                actor=actor,
                actor_type=actor_type,
            )
        )
        written.append(name)
    return written


def _guess_type(value: Any) -> str:
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float, Decimal)):
        return "number"
    if isinstance(value, str):
        return "string"
    if isinstance(value, (date, datetime)):
        return "datetime"
    if isinstance(value, list):
        return "array"
    return "json"


def sensitive_names(snapshot: dict) -> set[str]:
    return {v.get("name") for v in (snapshot.get("variables") or []) if v.get("sensitive")}


def mask_vars(snapshot: dict, values: dict[str, Any]) -> dict[str, Any]:
    masked = set(sensitive_names(snapshot))
    return {k: ("***" if k in masked and v not in (None, "") else v) for k, v in values.items()}


def env_snapshot(session: Session) -> dict:
    """给脚本沙箱/表达式用的只读组织快照（PRD Q5：MVP 本地缓存）。"""
    users = {
        u.id: {"id": u.id, "name": u.name, "dept_id": u.dept_id, "manager_id": u.manager_id, "roles": u.roles}
        for u in session.execute(select(User)).scalars()
    }
    depts = {
        d.id: {"id": d.id, "name": d.name, "leader_id": d.leader_id, "parent_id": d.parent_id}
        for d in session.execute(select(Dept)).scalars()
    }
    return {"users": users, "depts": depts}


def coerce_declared(decl: dict, value: Any) -> tuple[bool, Any, str | None]:
    """按 variables 声明做类型转换/校验（PRD §10.2）。宽松模式：能转就转，失败返回错误。"""
    name = decl.get("name")
    vtype = (decl.get("type") or "json").lower()
    if value is None:
        if decl.get("required"):
            return False, None, f"变量 {name} 必填"
        return True, None, None
    try:
        if vtype in ("number", "int", "float", "decimal", "amount"):
            if isinstance(value, bool):
                raise ValueError
            if vtype in ("decimal", "amount"):
                return True, str(Decimal(str(value))), None
            return True, float(value), None
        if vtype == "bool":
            if isinstance(value, bool):
                return True, value, None
            return True, str(value).lower() in ("1", "true", "yes", "on"), None
        if vtype == "string":
            return True, str(value), None
        if vtype == "date":
            return True, str(value)[:10], None
        if vtype == "datetime":
            datetime.fromisoformat(str(value))
            return True, str(value), None
        if vtype == "array":
            if not isinstance(value, list):
                raise ValueError
            return True, value, None
        return True, value, None
    except (ValueError, TypeError, InvalidOperation):
        return False, None, f"变量 {name} 的类型不符合声明（{vtype}）"
