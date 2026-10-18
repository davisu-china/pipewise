"""受限表达式语言（PRD §10.5）。

**不用 eval 原语**：先把源码 parse 成 AST，逐节点检查白名单，再自己递归求值。
表达式只读、无副作用；复杂逻辑一律落到脚本节点。

支持：变量引用（verdict / ctx.x / local.x / env.x / 裸变量）、比较、布尔、四则、
in/not in、三元、下标、白名单函数调用。
禁止：赋值、lambda、推导式、方法调用、属性链、import、任何未列入白名单的调用。
"""

from __future__ import annotations

import ast
import math
from datetime import date, datetime, timedelta
from decimal import Decimal


class ExprError(Exception):
    pass


_ALLOWED_NODES = (
    ast.Expression,
    ast.BoolOp,
    ast.BinOp,
    ast.UnaryOp,
    ast.Compare,
    ast.IfExp,
    ast.Call,
    ast.Name,
    ast.Attribute,
    ast.Subscript,
    ast.Constant,
    ast.Tuple,
    ast.List,
    ast.Dict,
    ast.Set,
    ast.Load,
    # 运算符
    ast.And,
    ast.Or,
    ast.Not,
    ast.Add,
    ast.Sub,
    ast.Mult,
    ast.Div,
    ast.FloorDiv,
    ast.Mod,
    ast.USub,
    ast.UAdd,
    ast.Eq,
    ast.NotEq,
    ast.Lt,
    ast.LtE,
    ast.Gt,
    ast.GtE,
    ast.In,
    ast.NotIn,
)

_ALLOWED_SCOPES = {"ctx", "local", "env", "task"}


def _days_between(a, b) -> int:
    def parse(v):
        if isinstance(v, datetime):
            return v.date()
        if isinstance(v, date):
            return v
        return date.fromisoformat(str(v)[:10])

    return (parse(b) - parse(a)).days


def _contains(hay, needle) -> bool:
    try:
        return needle in hay
    except TypeError:
        return str(needle) in str(hay)


def _functions(now_value: datetime | None) -> dict:
    now_fn = (lambda: now_value.replace(microsecond=0)) if now_value else datetime.utcnow
    return {
        "len": len,
        "contains": _contains,
        "startswith": lambda s, p: str(s).startswith(p),
        "endswith": lambda s, p: str(s).endswith(p),
        "lower": lambda s: str(s).lower(),
        "upper": lambda s: str(s).upper(),
        "int": int,
        "float": float,
        "str": str,
        "min": min,
        "max": max,
        "abs": abs,
        "round": round,
        "daysBetween": _days_between,
        "today": lambda: (now_value or datetime.utcnow()).date(),
        "now": now_fn,
        "sqrt": math.sqrt,
    }


def _check(node: ast.AST) -> None:
    if not isinstance(node, _ALLOWED_NODES):
        raise ExprError(f"表达式不允许的语法：{type(node).__name__}")
    if isinstance(node, ast.Attribute):
        # 只允许 ctx.x / local.x / env.x / task.x（一层，不做属性链）
        if not isinstance(node.value, ast.Name) or node.value.id not in _ALLOWED_SCOPES:
            raise ExprError("属性访问只允许 ctx./local./env./task. 一层")
    if isinstance(node, ast.Call):
        if not isinstance(node.func, ast.Name):
            raise ExprError("只允许调用白名单函数（不支持方法调用）")
        if node.func.id not in _functions(None):
            raise ExprError(f"函数不在白名单：{node.func.id}")
        if node.keywords:
            raise ExprError("表达式里的函数调用不允许关键字参数")
    for child in ast.iter_child_nodes(node):
        _check(child)


_cache: dict[str, ast.Expression] = {}


def compile_expr(src: str) -> ast.Expression:
    tree = _cache.get(src)
    if tree is None:
        try:
            tree = ast.parse(src, mode="eval")
        except SyntaxError as e:
            raise ExprError(f"表达式语法错误：{e.msg}（位置 {e.offset}）") from e
        _check(tree)
        _cache[src] = tree
    return tree


def validate_expr(src: str | None) -> None:
    if src is None or str(src).strip() == "":
        return
    compile_expr(str(src))


# ---------------------------------------------------------------- 求值


def _eval(node: ast.AST, scope: dict, funcs: dict):
    if isinstance(node, ast.Expression):
        return _eval(node.body, scope, funcs)
    if isinstance(node, ast.Constant):
        return node.value
    if isinstance(node, ast.Name):
        if node.id in scope:
            return scope[node.id]
        literals = {"true": True, "false": False, "null": None, "none": None}
        if node.id.lower() in literals:
            return literals[node.id.lower()]
        raise ExprError(f"未定义的变量：{node.id}")
    if isinstance(node, ast.Attribute):
        base = scope.get(node.value.id)
        if base is None:
            return None
        if isinstance(base, dict):
            return base.get(node.attr)
        return getattr(base, node.attr, None)
    if isinstance(node, ast.Subscript):
        base = _eval(node.value, scope, funcs)
        key = _eval(node.slice, scope, funcs)
        try:
            return base[key]
        except (KeyError, IndexError, TypeError) as e:
            raise ExprError(f"下标访问失败：{e}") from e
    if isinstance(node, ast.BoolOp):
        if isinstance(node.op, ast.And):
            val = True
            for v in node.values:
                val = _eval(v, scope, funcs)
                if not val:
                    return val
            return val
        val = False
        for v in node.values:
            val = _eval(v, scope, funcs)
            if val:
                return val
        return val
    if isinstance(node, ast.UnaryOp):
        v = _eval(node.operand, scope, funcs)
        if isinstance(node.op, ast.Not):
            return not v
        if isinstance(node.op, ast.USub):
            return -v
        return +v
    if isinstance(node, ast.BinOp):
        left = _eval(node.left, scope, funcs)
        right = _eval(node.right, scope, funcs)
        try:
            if isinstance(node.op, ast.Add):
                return left + right
            if isinstance(node.op, ast.Sub):
                return left - right
            if isinstance(node.op, ast.Mult):
                return left * right
            if isinstance(node.op, ast.Div):
                return left / right
            if isinstance(node.op, ast.FloorDiv):
                return left // right
            if isinstance(node.op, ast.Mod):
                return left % right
        except Exception as e:
            raise ExprError(f"运算失败：{e}") from e
        raise ExprError("不支持的运算符")
    if isinstance(node, ast.Compare):
        left = _eval(node.left, scope, funcs)
        for op, comparator in zip(node.ops, node.comparators):
            right = _eval(comparator, scope, funcs)
            ok = _compare(op, left, right)
            if not ok:
                return False
            left = right
        return True
    if isinstance(node, ast.IfExp):
        return _eval(node.body, scope, funcs) if _eval(node.test, scope, funcs) else _eval(node.orelse, scope, funcs)
    if isinstance(node, ast.Call):
        fn = funcs.get(node.func.id)
        if fn is None:
            raise ExprError(f"函数不在白名单：{node.func.id}")
        args = [_eval(a, scope, funcs) for a in node.args]
        try:
            return fn(*args)
        except Exception as e:
            raise ExprError(f"函数 {node.func.id} 执行失败：{e}") from e
    if isinstance(node, (ast.Tuple, ast.List)):
        return [_eval(e, scope, funcs) for e in node.elts]
    if isinstance(node, ast.Set):
        return {_eval(e, scope, funcs) for e in node.elts}
    if isinstance(node, ast.Dict):
        return {
            _eval(k, scope, funcs): _eval(v, scope, funcs)
            for k, v in zip(node.keys, node.values)
            if k is not None
        }
    raise ExprError(f"不支持的语法：{type(node).__name__}")


def _as_number(v):
    if isinstance(v, bool):
        return None
    if isinstance(v, (int, float, Decimal)):
        return float(v)
    if isinstance(v, str):
        try:
            return float(v)
        except ValueError:
            return None
    return None


def _compare(op, left, right) -> bool:
    # 金额在上下文里是 decimal 字符串（"6800.00"），和数字比较时自动转数值
    ln, rn = _as_number(left), _as_number(right)
    if ln is not None and rn is not None and (isinstance(left, str) or isinstance(right, str)):
        if isinstance(op, (ast.Eq, ast.NotEq, ast.Lt, ast.LtE, ast.Gt, ast.GtE)):
            left, right = ln, rn
    try:
        if isinstance(op, ast.Eq):
            return left == right
        if isinstance(op, ast.NotEq):
            return left != right
        if isinstance(op, ast.Lt):
            return left < right
        if isinstance(op, ast.LtE):
            return left <= right
        if isinstance(op, ast.Gt):
            return left > right
        if isinstance(op, ast.GtE):
            return left >= right
        if isinstance(op, ast.In):
            return left in right
        if isinstance(op, ast.NotIn):
            return left not in right
    except TypeError as e:
        raise ExprError(f"比较失败（类型不匹配）：{e}") from e
    raise ExprError("不支持的比较运算")


def evaluate(
    src: str,
    ctx: dict,
    local: dict | None = None,
    env: dict | None = None,
    extra: dict | None = None,
    now_value: datetime | None = None,
):
    """求值。`extra` 放 verdict/task 这类上下文；裸名字按 extra→local→ctx 解析。"""
    if src is None or str(src).strip() == "":
        return True
    tree = compile_expr(str(src))
    scope: dict = {}
    scope.update(ctx or {})
    if local:
        scope.update(local)
    scope["ctx"] = ctx or {}
    scope["local"] = local or {}
    scope["env"] = env or {}
    if extra:
        scope.update(extra)
    if extra and "task" in extra:
        scope["task"] = extra["task"]
    return _eval(tree, scope, _functions(now_value))


def expr_names(src: str) -> set[str]:
    """收集表达式里引用的裸名字（用于发布校验的"变量未声明"警告）。"""
    if not src or not str(src).strip():
        return set()
    try:
        tree = compile_expr(str(src))
    except ExprError:
        return set()
    names = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Name):
            names.add(node.id)
    return {n for n in names if n not in _ALLOWED_SCOPES}


def to_decimal(v) -> Decimal:
    return Decimal(str(v))
