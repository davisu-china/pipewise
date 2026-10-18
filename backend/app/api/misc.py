"""杂项：健康检查、当前用户、用户列表、演示用的 webhook 接收器。"""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..config import settings
from ..db import get_session
from ..engine.errors import ApiError
from ..models import DevSink, User
from .deps import current_user
from .serializers import user_dict

router = APIRouter(tags=["misc"])


@router.get("/health")
def health():
    return {"status": "ok", "service": "pipewise"}


@router.get("/me")
def me(user: User = Depends(current_user)):
    return user_dict(user)


@router.get("/users")
def users(session: Session = Depends(get_session), user: User = Depends(current_user)):
    rows = session.execute(select(User).where(User.active.is_(True)).order_by(User.id)).scalars()
    return {"items": [user_dict(u) for u in rows]}


@router.get("/dev/demo-users")
def demo_users(session: Session = Depends(get_session)):
    """**仅演示模式开放**：把种子用户的 token 给前端用户切换器。

    `PIPEWISE_DEMO=0`（默认）时返回 404——token 等同于账号，不能裸露在生产接口里。
    """
    if not settings.DEMO:
        raise ApiError(404, "NOT_FOUND", "演示模式未开启")
    rows = session.execute(select(User).where(User.active.is_(True)).order_by(User.id)).scalars()
    return {"items": [{"id": u.id, "name": u.name, "roles": u.roles, "token": u.token} for u in rows]}


@router.post("/dev/webhook-sink")
async def webhook_sink(request: Request, session: Session = Depends(get_session)):
    """演示用的事件接收器：把收到的 webhook 原样存库（生产不需要）。"""
    body = await request.json()
    session.add(
        DevSink(
            event_type=str(body.get("type") or "unknown"),
            payload_json=body,
            signature=request.headers.get("X-PipeWise-Signature"),
        )
    )
    return {"ok": True}
