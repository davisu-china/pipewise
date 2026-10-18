"""脚本节点的执行器：把子进程沙箱包成一次函数调用（技术方案 §3.12）。"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone

from ..config import settings

RUNNER = os.path.join(os.path.dirname(__file__), "sandbox_runner.py")


@dataclass
class ScriptResult:
    ok: bool
    result: dict = field(default_factory=dict)
    sets: dict = field(default_factory=dict)
    local: dict = field(default_factory=dict)
    logs: list[str] = field(default_factory=list)
    error: str | None = None
    trace: str | None = None
    duration_ms: int = 0


def run_script(
    source: str,
    ctx: dict,
    local: dict | None = None,
    env: dict | None = None,
    timeout_ms: int | None = None,
    memory_mb: int | None = None,
) -> ScriptResult:
    timeout_ms = timeout_ms or settings.SCRIPT_TIMEOUT_MS
    payload = {
        "script": source,
        "ctx": ctx,
        "local": local or {},
        "env": env or {},
        "timeout_ms": timeout_ms,
        "memory_mb": memory_mb or settings.SCRIPT_MEMORY_MB,
        # 注入固定时间：脚本读不到系统时间，保证重放一致（PRD §11.1）
        "now": datetime.now(timezone.utc).replace(microsecond=0).isoformat(),
    }
    started = time.monotonic()
    try:
        proc = subprocess.run(  # noqa: S603 —— 入参为固定解释器 + 固定脚本，业务代码只走 stdin
            [sys.executable, "-I", "-S", RUNNER],
            input=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
            capture_output=True,
            timeout=timeout_ms / 1000.0,
            start_new_session=True,
        )
    except subprocess.TimeoutExpired:
        return ScriptResult(ok=False, error=f"脚本执行超时（>{timeout_ms}ms）", duration_ms=int((time.monotonic() - started) * 1000))

    duration = int((time.monotonic() - started) * 1000)
    stderr = proc.stderr.decode("utf-8", "replace").strip()
    if proc.returncode != 0:
        reason = f"沙箱进程退出码 {proc.returncode}"
        if proc.returncode < 0:
            reason += f"（信号 {-proc.returncode}，可能是 CPU/内存超限）"
        return ScriptResult(ok=False, error=reason, trace=stderr[-2000:], duration_ms=duration)

    try:
        out = json.loads(proc.stdout.decode("utf-8"))
    except json.JSONDecodeError:
        return ScriptResult(
            ok=False,
            error="沙箱输出不是合法 JSON",
            trace=(proc.stdout.decode("utf-8", "replace")[-500:] + "\n" + stderr[-1000:]),
            duration_ms=duration,
        )

    return ScriptResult(
        ok=bool(out.get("ok")),
        result=out.get("result") or {},
        sets=out.get("sets") or {},
        local=out.get("local") or {},
        logs=out.get("logs") or [],
        error=out.get("error"),
        trace=out.get("trace"),
        duration_ms=duration,
    )
