"""后台巡检（技术方案 §3.8）：

1. 续跑遗留的 ACTIVE 令牌（进程崩在事务外/未提交的极端情况）；
2. 投递 outbox；
3. join 卡点告警（不自动跳过，PRD §17-1）。
"""

from __future__ import annotations

import logging
import threading
import time
from datetime import datetime, timedelta, timezone

from sqlalchemy import select

from ..config import settings
from ..db import session_scope
from ..models import AuditLog, Instance, Outbox, Token

log = logging.getLogger("pipewise.dispatcher")


def sweep_once() -> dict:
    stats = {"advanced": 0, "delivered": 0, "stalled": 0}
    with session_scope() as session:
        # 1) 遗留 ACTIVE 令牌
        ids = list(
            session.execute(
                select(Token.instance_id)
                .join(Instance, Instance.id == Token.instance_id)
                .where(Token.status == "ACTIVE", Instance.dry_run.is_(False), Instance.status == "RUNNING")
                .distinct()
            ).scalars()
        )
        if ids:
            from .engine import engine

            for iid in ids:
                inst = session.get(Instance, iid)
                if inst:
                    engine.advance(session, inst, "dispatcher")
                    stats["advanced"] += 1

        # 2) outbox
        from .outbox import deliver_once

        result = deliver_once(session)
        stats["delivered"] = result["delivered"]

        # 3) join 卡点巡检
        stats["stalled"] = _check_stalls(session)
    return stats


def _check_stalls(session) -> int:
    threshold = datetime.now(timezone.utc) - timedelta(minutes=settings.JOIN_STALL_MINUTES)
    stale = list(
        session.execute(
            select(Token).where(Token.status == "WAITING", Token.updated_at < threshold)
        ).scalars()
    )
    count = 0
    for t in stale:
        inst = session.get(Instance, t.instance_id)
        if not inst or inst.status != "RUNNING":
            continue
        # 同一个 (实例, 节点) 一小时内只报一次
        recent = session.execute(
            select(AuditLog.id).where(
                AuditLog.instance_id == inst.id,
                AuditLog.node_instance_id.is_(None),
                AuditLog.action == "join.stalled",
                AuditLog.created_at > datetime.now(timezone.utc) - timedelta(hours=1),
            )
        ).first()
        if recent:
            continue
        session.add(
            AuditLog(
                instance_id=inst.id,
                action="join.stalled",
                actor="dispatcher",
                detail_json={"node": t.node_id, "waiting_since": t.updated_at.isoformat()},
            )
        )
        session.add(
            Outbox(
                instance_id=inst.id,
                type="join.stalled",
                payload_json={
                    "type": "join.stalled",
                    "instance_id": inst.id,
                    "definition_key": inst.definition_key,
                    "node_id": t.node_id,
                    "at": datetime.now(timezone.utc).isoformat(),
                },
            )
        )
        count += 1
    return count


class DispatcherThread(threading.Thread):
    def __init__(self) -> None:
        super().__init__(name="pipewise-dispatcher", daemon=True)
        self._stop = threading.Event()

    def run(self) -> None:
        while not self._stop.is_set():
            try:
                stats = sweep_once()
                if any(stats.values()):
                    log.info("dispatcher: %s", stats)
            except Exception:  # noqa: BLE001 —— 巡检不能把进程带崩
                log.exception("dispatcher sweep failed")
            self._stop.wait(settings.DISPATCH_INTERVAL_S)

    def stop(self) -> None:
        self._stop.set()
