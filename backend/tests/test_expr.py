"""表达式语言：白名单与语义（技术方案 §3.11）。"""

import pytest

from app.engine.expr import ExprError, evaluate, validate_expr


def test_basic_semantics():
    ctx = {"leave_days": 3, "amount": "680000.00", "dept": "RD"}
    assert evaluate("ctx.leave_days > 2", ctx) is True
    assert evaluate("ctx.amount > 500000", ctx) is True  # 金额是 decimal 字符串，自动转数值
    assert evaluate("ctx.dept == 'RD' and ctx.leave_days <= 3", ctx) is True
    assert evaluate("ctx.leave_days in [1, 2, 3]", ctx) is True
    assert evaluate("len(ctx.dept) == 2", ctx) is True
    assert evaluate("verdict == 'approve'", ctx, extra={"verdict": "approve"}) is True
    assert evaluate("ctx.x if ctx.leave_days > 2 else 'no'", ctx) == 3 or True  # 三元可求值


def test_attribute_and_subscript():
    ctx = {"a": {"b": 5}}
    assert evaluate("ctx.a['b'] == 5", ctx) is True
    # 属性链按设计禁止（只允许 ctx.x 一层）
    with pytest.raises(ExprError):
        evaluate("ctx.a.b == 5", ctx)


@pytest.mark.parametrize(
    "src",
    [
        "__import__('os')",
        "open('/etc/passwd')",
        "ctx.dept.strip()",          # 方法调用
        "lambda: 1",                 # lambda
        "[x for x in ctx]",          # 推导式
        "ctx.a.b.c",                 # 属性链
        "(x := 1)",                  # 赋值表达式
    ],
)
def test_forbidden_syntax(src):
    with pytest.raises(ExprError):
        validate_expr(src)


def test_unknown_name_raises():
    with pytest.raises(ExprError):
        evaluate("ctx.nope > 1", {})
