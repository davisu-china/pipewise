"""事件投递：Outbox 模式（PRD §13.2 / 技术方案 §5）。

事件与状态变更同事务落库；投递器异步推送，失败按指数退避重试，超限进死信。
投递带 HMAC 签名：`X-PipeWise-Signature: t=<unixts>,v1=<hex>`。
"""

from __future__ import annotations

import hashlib
import hmac
import json
from datetime import datetime, timedelta, timezone

import httpx
from sqlalchemy import or_, select
from sqlalchemy.orm import Session

from ..config import settings
from ..models import Outbox, Webhook


def _sign(secret: str, timestamp: int, body: str) -> str:
    mac = hmac.new(secret.encode("utf-8"), f"{timestamp}.{body}".encode("utf-8"), hashlib.sha256)
    return mac.hexdigest()


def deliver_once(session: Session, limit: int = 50) -> dict:
    now = datetime.now(timezone.utc)
    rows = list(
        session.execute(
            select(Outbox)
            .where(
                Outbox.status == "PENDING",
                or_(Outbox.next_retry_at.is_(None), Outbox.next_retry_at <= now),
            )
            .order_by(Outbox.id)
            .limit(limit)
            .with_for_update(skip_locked=True)
        ).scalars()
    )
    stats = {"pending": len(rows), "delivered": 0, "retried": 0, "dead": 0}
    if not rows:
        return stats

    hooks = list(
        session.execute(select(Webhook).where(Webhook.enabled.is_(True))).scalars()
    )
    for row in rows:
        targets = [h for h in hooks if h.definition_key in (None, "", row.payload_json.get("definition_key"))]
        if not targets:
            row.status = "DELIVERED"
            row.delivered_at = now
            row.attempts += 1
            stats["delivered"] += 1
            continue

        body = json.dumps(row.payload_json, ensure_ascii=False)
        ts = int(now.timestamp())
        ok = True
        for h in targets:
            headers = {"Content-Type": "application/json", "X-PipeWise-Event": row.type}
            if h.secret:
                headers["X-PipeWise-Signature"] = f"t={ts},v1={_sign(h.secret, ts, body)}"
            try:
                resp = httpx.post(h.url, content=body.encode("utf-8"), headers=headers, timeout=5.0)
                if resp.status_code >= 300:
                    ok = False
            except Exception:  # noqa: BLE001 —— 投递失败一律重试
                ok = False

        row.attempts += 1
        if ok:
            row.status = "DELIVERED"
            row.delivered_at = now
            stats["delivered"] += 1
            continue

        if row.attempts > len(settings.OUTBOX_BACKOFF_S):
            row.status = "DEAD"
            stats["dead"] += 1
        else:
            delay = settings.OUTBOX_BACKOFF_S[row.attempts - 1]
            row.next_retry_at = now + timedelta(seconds=delay)
            stats["retried"] += 1
    session.flush()
    return stats
