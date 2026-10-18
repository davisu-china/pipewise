"""请求级事务中间件。

一个请求 = 一个事务：路由里的所有写入在**响应返回给客户端之前**提交。
4xx（业务错误）整体回滚；5xx 也回滚。
"""

from __future__ import annotations

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

from .db import SessionLocal


class DBSessionMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        session = SessionLocal()
        request.state.db = session
        try:
            response = await call_next(request)
        except Exception:
            session.rollback()
            session.close()
            raise
        try:
            if response.status_code < 400:
                session.commit()
            else:
                session.rollback()
        except Exception:
            session.rollback()
            raise
        finally:
            session.close()
        return response
