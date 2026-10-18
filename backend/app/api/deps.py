"""鉴权与通用依赖。

MVP 用 Bearer token → wf_user；角色能力见技术方案 §7。
"""

from __future__ import annotations

from typing import Callable

from fastapi import Depends, Header
from sqlalchemy import select
from sqlalchemy.orm import Session

from ..db import get_session
from ..engine.errors import ApiError
from ..models import IdempotencyKey, User


def current_user(
    authorization: str | None = Header(default=None),
    x_pipewise_token: str | None = Header(default=None, alias="X-PipeWise-Token"),
    session: Session = Depends(get_session),
) -> User:
    """两种凭证二选一：

    - `X-PipeWise-Token: <token>`：**Web 前端用这个**。整站挂在 nginx Basic Auth 后面时，
      `Authorization` 头被 Basic 占用，SPA 再往同一个头上写 Bearer 会把 Basic 冲掉，
      nginx 直接 401（线上踩过：能过 Basic 登录，但页面里每个接口都 401）。
    - `Authorization: Bearer <token>`：SDK / 脚本 / 直连 API 用，保持兼容。
    """
    token = (x_pipewise_token or "").strip()
    if not token:
        if not authorization or not authorization.lower().startswith("bearer "):
            raise ApiError(401, "UNAUTHORIZED", "请先登录（缺少访问令牌）")
        token = authorization.split(" ", 1)[1].strip()
    user = session.execute(select(User).where(User.token == token, User.active.is_(True))).scalar_one_or_none()
    if user is None:
        raise ApiError(401, "UNAUTHORIZED", "token 无效")
    return user


def require_roles(*roles: str) -> Callable:
    def dep(user: User = Depends(current_user)) -> User:
        if "admin" in (user.roles or []):
            return user
        if any(r in (user.roles or []) for r in roles):
            return user
        raise ApiError(403, "FORBIDDEN", f"需要这些角色之一：{', '.join(roles)}")

    return dep


def idempotent(
    session: Session,
    scope: str,
    key: str | None,
    user: User,
    run: Callable[[], dict],
) -> dict:
    """同键重复请求回放首次响应（PRD §13.2）。"""
    if not key:
        return run()
    existing = session.execute(
        select(IdempotencyKey).where(IdempotencyKey.scope == scope, IdempotencyKey.key == key)
    ).scalar_one_or_none()
    if existing:
        return existing.response_json
    result = run()
    session.add(IdempotencyKey(scope=scope, key=key, user_id=user.id, response_json=result))
    return result
