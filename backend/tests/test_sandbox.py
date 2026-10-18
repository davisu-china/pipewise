"""脚本沙箱（技术方案 §3.12）。"""

import time

from app.engine.script import run_script

GOOD = """
def run(ctx, local, env, logger, now):
    days = ctx.get('leave_days', 0)
    ctx.set('allowance', days * 500)
    local['tmp'] = 1
    logger.info('days=%s', days)
    return {'leave_left': max(0, 15 - days)}
"""


def test_runs_and_returns():
    r = run_script(GOOD, {"leave_days": 3}, {}, {"users": {}})
    assert r.ok and r.result == {"leave_left": 12} and r.sets == {"allowance": 1500}
    assert any("days=3" in line for line in r.logs)


def test_import_blocked():
    r = run_script("def run(ctx, local, env, logger, now):\n    import os\n    return {}", {}, {}, {})
    assert not r.ok and "ImportError" in (r.error or "")


def test_timeout_kills_process():
    started = time.monotonic()
    r = run_script("def run(ctx, local, env, logger, now):\n    while True: pass", {}, {}, {}, timeout_ms=600)
    assert not r.ok and "超时" in (r.error or "")
    assert time.monotonic() - started < 5


def test_exception_reported_with_trace():
    r = run_script("def run(ctx, local, env, logger, now):\n    return 1/0", {}, {}, {})
    assert not r.ok and "ZeroDivisionError" in (r.error or "") and "run" in (r.trace or "")


def test_missing_entry_rejected():
    r = run_script("x = 1", {}, {}, {})
    assert not r.ok and "run(" in (r.error or "")


def test_user_lookup_from_snapshot():
    src = """
def run(ctx, local, env, logger, now):
    u = user('u_lisi')
    return {'manager': u['manager_id']}
"""
    r = run_script(src, {}, {}, {"users": {"u_lisi": {"id": "u_lisi", "manager_id": "u_zhangwei"}}, "depts": {}})
    assert r.ok and r.result == {"manager": "u_zhangwei"}
