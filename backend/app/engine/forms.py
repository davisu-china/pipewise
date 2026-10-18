"""表单引擎：Schema、节点×字段权限矩阵、三层校验（PRD 第 10 章 / 技术方案 §4）。"""

from __future__ import annotations

import re
from datetime import date, datetime
from decimal import Decimal, InvalidOperation
from typing import Any

from sqlalchemy import desc, select
from sqlalchemy.orm import Session

from ..models import Form, FormVersion
from .expr import ExprError, evaluate

FIELD_TYPES = {
    "text",
    "textarea",
    "number",
    "amount",
    "date",
    "datetime",
    "switch",
    "select",
    "multi_select",
    "rating",
    "user",
    "dept",
    "file",
    "static",
}

ACCESS_VALUES = ("editable", "readonly", "hidden")


# ---------------------------------------------------------------- 读取


def get_published_form(session: Session, key: str) -> FormVersion | None:
    form = session.execute(select(Form).where(Form.key == key)).scalar_one_or_none()
    if not form:
        return None
    return session.execute(
        select(FormVersion)
        .where(FormVersion.form_id == form.id, FormVersion.status == "PUBLISHED")
        .order_by(desc(FormVersion.version))
        .limit(1)
    ).scalar_one_or_none()


def published_form_schemas(session: Session) -> dict[str, dict]:
    """发布校验用：所有表单的最新已发布 schema。"""
    out: dict[str, dict] = {}
    for form in session.execute(select(Form)).scalars():
        fv = session.execute(
            select(FormVersion)
            .where(FormVersion.form_id == form.id, FormVersion.status == "PUBLISHED")
            .order_by(desc(FormVersion.version))
            .limit(1)
        ).scalar_one_or_none()
        if fv:
            out[form.key] = fv.schema_json
    return out


def field_defs(schema: dict) -> dict[str, dict]:
    return {f["name"]: f for f in (schema or {}).get("fields", []) if f.get("name")}


def permission_of(permissions: dict, name: str) -> dict:
    """节点未配置的字段 → 默认只读（PRD §10.2）。"""
    perm = (permissions or {}).get(name) or {}
    access = perm.get("access") or "readonly"
    if access not in ACCESS_VALUES:
        access = "readonly"
    return {"access": access, "required": bool(perm.get("required"))}


# ---------------------------------------------------------------- 渲染


def build_form_payload(
    node: dict,
    schema: dict,
    values: dict[str, Any],
) -> dict:
    """返回给客户端的表单：隐藏字段**不出现**，并带上服务端求出的权限。"""
    permissions = node.get("fieldPermissions") or {}
    fields = []
    for f in (schema or {}).get("fields", []):
        name = f.get("name")
        ftype = f.get("type") or "text"
        if ftype == "static":
            fields.append({"name": None, "label": f.get("label"), "type": "static", "text": f.get("text") or ""})
            continue
        if not name:
            continue
        perm = permission_of(permissions, name)
        if perm["access"] == "hidden":
            continue
        fields.append(
            {
                "name": name,
                "label": f.get("label") or name,
                "type": ftype,
                "options": f.get("options"),
                "placeholder": f.get("placeholder"),
                "help": f.get("help"),
                "access": perm["access"],
                "required": perm["required"] if perm["access"] == "editable" else False,
                "value": values.get(name),
                "min": f.get("min"),
                "max": f.get("max"),
                "max_length": f.get("max_length"),
                "pattern": f.get("pattern"),
            }
        )
    return {
        "form_key": (schema or {}).get("key"),
        "form_name": (schema or {}).get("name"),
        "form_version": (schema or {}).get("version"),
        "node_id": node.get("id"),
        "fields": fields,
    }


# ---------------------------------------------------------------- 校验


def validate_submission(
    schema: dict,
    permissions: dict,
    submitted: dict,
    existing: dict[str, Any],
    now_value: datetime | None = None,
) -> tuple[dict, list[dict], list[dict]]:
    """三层校验里的服务端层（PRD §10.6）。

    返回 (可写入的变量, 被丢弃的越权字段, 结构化错误)。
    - 只读/隐藏字段被提交且与原值不同 → **丢弃并记录**，不报错（防前端篡改，PRD §17-20）
    - 可编辑 + 必填为空 → 错误
    - 类型/正则/范围/选项/跨字段校验 → 错误
    """
    defs = field_defs(schema)
    updates: dict[str, Any] = {}
    dropped: list[dict] = []
    errors: list[dict] = []

    for name, value in (submitted or {}).items():
        if name not in defs:
            dropped.append({"field": name, "reason": "表单里没有这个字段"})
            continue
        perm = permission_of(permissions, name)
        if perm["access"] != "editable":
            old = existing.get(name)
            if not _same(old, value):
                dropped.append(
                    {
                        "field": name,
                        "reason": f"字段在节点 {schema.get('key')} 上为 {perm['access']}，越权写入已丢弃",
                        "submitted": value,
                        "kept": old,
                    }
                )
            continue
        ok, coerced, err = coerce_field(defs[name], value)
        if not ok:
            errors.append({"field": name, "code": "FIELD_INVALID", "message": err})
            continue
        updates[name] = coerced

    # 必填（可编辑字段即使没提交也要判定）
    for name, f in defs.items():
        if (f.get("type") or "") == "static":
            continue
        perm = permission_of(permissions, name)
        if perm["access"] != "editable":
            continue
        required = bool(perm.get("required") or f.get("required"))
        if required and _empty(updates.get(name, submitted.get(name))):
            errors.append({"field": name, "code": "FIELD_REQUIRED", "message": f"{f.get('label') or name} 必填"})

    # 跨字段校验：字段上的 validate 表达式，用合并后的候选值求值
    merged = {**existing, **updates}
    for name, f in defs.items():
        rule = f.get("validate")
        if not rule:
            continue
        try:
            ok = evaluate(str(rule), merged, extra={"form": merged}, now_value=now_value)
        except ExprError as e:
            errors.append({"field": name, "code": "FIELD_RULE_ERROR", "message": f"校验规则执行失败：{e}"})
            continue
        if not ok:
            errors.append(
                {
                    "field": name,
                    "code": "FIELD_RULE_FAILED",
                    "message": f.get("validate_message") or f"{f.get('label') or name} 不满足校验规则",
                }
            )

    return updates, dropped, errors


def coerce_field(field: dict, value: Any) -> tuple[bool, Any, str | None]:
    name = field.get("name")
    label = field.get("label") or name
    ftype = field.get("type") or "text"
    if value is None:
        return True, None, None
    try:
        if ftype in ("text", "textarea", "file"):
            s = str(value)
            max_len = field.get("max_length")
            if max_len and len(s) > int(max_len):
                return False, None, f"{label} 超过 {max_len} 个字符"
            pattern = field.get("pattern")
            if pattern and not re.fullmatch(str(pattern), s):
                return False, None, f"{label} 格式不正确"
            return True, s, None

        if ftype == "number":
            n = float(value)
            if isinstance(value, bool):
                raise ValueError
            _check_range(field, n, label)
            return True, n, None

        if ftype == "amount":
            d = Decimal(str(value))
            _check_range(field, float(d), label)
            return True, str(d), None

        if ftype == "switch":
            if isinstance(value, bool):
                return True, value, None
            return True, str(value).lower() in ("1", "true", "yes", "on"), None

        if ftype == "rating":
            n = int(value)
            if n < 0 or n > 10:
                return False, None, f"{label} 取值 0–10"
            return True, n, None

        if ftype == "date":
            s = str(value)[:10]
            date.fromisoformat(s)
            return True, s, None

        if ftype == "datetime":
            s = str(value)
            datetime.fromisoformat(s)
            return True, s, None

        if ftype == "select":
            options = field.get("options") or []
            allowed = {str(o.get("value")) for o in options if isinstance(o, dict)}
            if allowed and str(value) not in allowed:
                return False, None, f"{label} 取值不在选项内"
            return True, value, None

        if ftype == "multi_select":
            if not isinstance(value, list):
                return False, None, f"{label} 需要是多选列表"
            options = field.get("options") or []
            allowed = {str(o.get("value")) for o in options if isinstance(o, dict)}
            if allowed:
                bad = [v for v in value if str(v) not in allowed]
                if bad:
                    return False, None, f"{label} 含非法选项：{bad}"
            return True, value, None

        if ftype in ("user", "dept"):
            return True, str(value), None

        return True, value, None
    except (ValueError, TypeError, InvalidOperation):
        return False, None, f"{label} 的类型不正确"


def _check_range(field: dict, n: float, label: str) -> None:
    if field.get("min") is not None and n < float(field["min"]):
        raise ValueError(f"{label} 不能小于 {field['min']}")
    if field.get("max") is not None and n > float(field["max"]):
        raise ValueError(f"{label} 不能大于 {field['max']}")


def _empty(v: Any) -> bool:
    return v is None or (isinstance(v, str) and v.strip() == "") or (isinstance(v, list) and not v)


def _same(a: Any, b: Any) -> bool:
    if isinstance(a, Decimal) or isinstance(b, Decimal):
        try:
            return Decimal(str(a)) == Decimal(str(b))
        except (InvalidOperation, TypeError):
            return False
    if isinstance(a, (int, float)) and isinstance(b, (int, float)):
        return float(a) == float(b)
    return a == b
