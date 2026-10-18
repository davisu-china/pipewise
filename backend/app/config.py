"""运行配置。

全部来自环境变量：密钥不进仓库，容器里注入最省事（和相悦的做法一致）。
"""

import os


def _int(name: str, default: int) -> int:
    v = os.getenv(name)
    if not v:
        return default
    try:
        return int(v)
    except ValueError:
        return default


class Settings:
    # 数据库：默认连本机 PG 的 pipewise 库（开发用 trust 认证）
    DATABASE_URL: str = os.getenv(
        "DATABASE_URL",
        "postgresql+psycopg://mutual@127.0.0.1:5433/pipewise",
    )

    # 引擎保护（PRD §9.5）
    MAX_STEPS: int = _int("MAX_STEPS", 1000)
    MAX_NODE_ACTIVATIONS: int = _int("MAX_NODE_ACTIVATIONS", 100)
    MAX_PARALLEL_DEPTH: int = _int("MAX_PARALLEL_DEPTH", 3)

    # 脚本沙箱（PRD §11.1）
    SCRIPT_TIMEOUT_MS: int = _int("SCRIPT_TIMEOUT_MS", 3000)
    SCRIPT_MEMORY_MB: int = _int("SCRIPT_MEMORY_MB", 256)

    # join 卡点巡检阈值（分钟）
    JOIN_STALL_MINUTES: int = _int("JOIN_STALL_MINUTES", 30)

    # dispatcher 轮询间隔（秒）；设为 0 可关闭（测试里用）
    DISPATCH_INTERVAL_S: float = float(os.getenv("DISPATCH_INTERVAL_S", "2"))

    # 事件投递重试间隔（秒）
    OUTBOX_BACKOFF_S: list[int] = [2, 8, 30, 120, 600]

    # 演示模式：为 1 时开放 /dev/demo-users（把种子用户的 token 给演示前端切换用）。
    # 生产环境必须关闭（接 SSO/OIDC 之前，用 nginx Basic Auth 做外层保护）。
    DEMO: bool = False

    def __init__(self) -> None:
        # 允许测试里覆盖
        self.DATABASE_URL = os.getenv("DATABASE_URL", self.DATABASE_URL)
        self.MAX_STEPS = _int("MAX_STEPS", self.MAX_STEPS)
        self.MAX_NODE_ACTIVATIONS = _int("MAX_NODE_ACTIVATIONS", self.MAX_NODE_ACTIVATIONS)
        self.MAX_PARALLEL_DEPTH = _int("MAX_PARALLEL_DEPTH", self.MAX_PARALLEL_DEPTH)
        self.SCRIPT_TIMEOUT_MS = _int("SCRIPT_TIMEOUT_MS", self.SCRIPT_TIMEOUT_MS)
        self.SCRIPT_MEMORY_MB = _int("SCRIPT_MEMORY_MB", self.SCRIPT_MEMORY_MB)
        self.JOIN_STALL_MINUTES = _int("JOIN_STALL_MINUTES", self.JOIN_STALL_MINUTES)
        self.DISPATCH_INTERVAL_S = float(os.getenv("DISPATCH_INTERVAL_S", str(self.DISPATCH_INTERVAL_S)))
        self.DEMO = os.getenv("PIPEWISE_DEMO", "0") == "1"


settings = Settings()
