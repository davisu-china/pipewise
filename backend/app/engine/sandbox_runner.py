"""脚本沙箱的执行体（独立进程，`python -I -S sandbox_runner.py`）。

**不要 import 本项目的任何模块**：这个文件被刻意设计成只依赖标准库，
配合 `-S`（不加载 site-packages）与 `-I`（隔离模式）形成最小执行环境。
父进程通过 stdin 传 JSON、从 stdout 收 JSON；超时/内存由父进程 + rlimit 双重限制。
"""

import datetime
import decimal
import json
import math
import re
import resource
import sys

MAX_LOGS = 200


class Scope:
    """ctx / local：支持 .get/.set、下标、属性读写。写入记录在 _sets，由父进程落库。"""

    def __init__(self, data):
        object.__setattr__(self, "_data", dict(data or {}))
        object.__setattr__(self, "_sets", {})

    def get(self, key, default=None):
        if key in self._sets:
            return self._sets[key]
        return self._data.get(key, default)

    def set(self, key, value):
        self._sets[key] = value
        return value

    def __getitem__(self, key):
        return self.get(key)

    def __setitem__(self, key, value):
        self._sets[key] = value

    def __contains__(self, key):
        return key in self._sets or key in self._data

    def __getattr__(self, key):
        if key.startswith("_"):
            raise AttributeError(key)
        return self.get(key)

    def __setattr__(self, key, value):
        if key.startswith("_"):
            object.__setattr__(self, key, value)
        else:
            self._sets[key] = value

    def dump(self):
        return dict(self._data)


class ReadOnlyEnv:
    def __init__(self, data):
        object.__setattr__(self, "_data", dict(data or {}))

    def get(self, key, default=None):
        return self._data.get(key, default)

    def __getitem__(self, key):
        return self._data.get(key)

    def __getattr__(self, key):
        if key.startswith("_"):
            raise AttributeError(key)
        return self._data.get(key)


class Logger:
    def __init__(self):
        self.lines = []

    def _log(self, level, msg):
        if len(self.lines) < MAX_LOGS:
            self.lines.append(f"[{level}] {msg}")

    def debug(self, msg, *args):
        self._log("debug", _fmt(msg, args))

    def info(self, msg, *args):
        self._log("info", _fmt(msg, args))

    def warn(self, msg, *args):
        self._log("warn", _fmt(msg, args))

    warning = warn

    def error(self, msg, *args):
        self._log("error", _fmt(msg, args))


def _fmt(msg, args):
    if args:
        try:
            return msg % args
        except Exception:
            return " ".join([str(msg)] + [str(a) for a in args])
    return str(msg)


def _safe_builtins(allowed_modules):
    import builtins

    allowed = [
        "abs", "all", "any", "bool", "dict", "divmod", "enumerate", "float", "format",
        "int", "len", "list", "max", "min", "range", "reversed", "round", "set",
        "sorted", "str", "sum", "tuple", "zip", "isinstance", "ValueError", "TypeError",
        "KeyError", "Exception", "True", "False", "None",
    ]
    safe = {}
    for name in allowed:
        if hasattr(builtins, name):
            safe[name] = getattr(builtins, name)

    def _import(name, globals=None, locals=None, fromlist=(), level=0):
        root = name.split(".")[0]
        if root in allowed_modules:
            return allowed_modules[root]
        raise ImportError(f"沙箱不允许导入模块：{name}")

    safe["__import__"] = _import
    return safe


def main():
    raw = sys.stdin.buffer.read()
    payload = json.loads(raw.decode("utf-8"))

    timeout_ms = int(payload.get("timeout_ms", 3000))
    memory_mb = int(payload.get("memory_mb", 256))

    cpu_seconds = max(1, int(math.ceil(timeout_ms / 1000.0)))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds + 1))
    mem_bytes = memory_mb * 1024 * 1024
    resource.setrlimit(resource.RLIMIT_AS, (mem_bytes, mem_bytes))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
    try:
        resource.setrlimit(resource.RLIMIT_NOFILE, (64, 64))
    except (ValueError, OSError):
        pass

    allowed_modules = {
        "json": json,
        "math": math,
        "re": re,
        "datetime": datetime,
        "decimal": decimal,
    }
    ctx = Scope(payload.get("ctx") or {})
    local = Scope(payload.get("local") or {})
    env_data = payload.get("env") or {}
    env = ReadOnlyEnv(env_data)
    logger = Logger()

    now_value = datetime.datetime.fromisoformat(payload["now"])

    def now_fn():
        return now_value

    users = env_data.get("users") or {}
    depts = env_data.get("depts") or {}

    def user(uid):
        u = users.get(str(uid))
        return dict(u) if u else None

    def dept(did):
        d = depts.get(str(did))
        return dict(d) if d else None

    g = {
        "__builtins__": _safe_builtins(allowed_modules),
        "__name__": "pipewise_sandbox",
        "ctx": ctx,
        "local": local,
        "env": env,
        "logger": logger,
        "now": now_fn,
        "user": user,
        "dept": dept,
        "json": json,
        "math": math,
        "re": re,
        "datetime": datetime,
        "decimal": decimal,
        "Decimal": decimal.Decimal,
    }

    source = payload.get("script") or ""
    try:
        code = compile(source, "<script>", "exec")
        exec(code, g)  # noqa: S102 —— 这是沙箱的既定行为，见技术方案 §3.12
        fn = g.get("run")
        if not callable(fn):
            raise RuntimeError("脚本必须定义 run(ctx, local, env, logger, now)")
        result = fn(ctx, local, env, logger, now_fn)
        if result is not None and not isinstance(result, dict):
            raise TypeError(f"run() 必须返回 None 或 dict，实际 {type(result).__name__}")
        out = {
            "ok": True,
            "result": result or {},
            "sets": dict(ctx._sets),
            "local": dict(local._sets),
            "logs": logger.lines,
        }
    except Exception as e:  # noqa: BLE001 —— 沙箱边界，把异常原样带回父进程
        import traceback

        out = {
            "ok": False,
            "error": f"{type(e).__name__}: {e}",
            "trace": "\n".join(traceback.format_exc().splitlines()[-15:]),
            "sets": dict(ctx._sets),
            "local": dict(local._sets),
            "logs": logger.lines,
        }

    data = json.dumps(out, ensure_ascii=False, default=str)
    if len(data.encode("utf-8")) > 1 << 20:
        data = json.dumps({"ok": False, "error": "脚本输出超过 1MB 上限", "logs": logger.lines[-20:]})
    sys.stdout.write(data)


if __name__ == "__main__":
    main()
