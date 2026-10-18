"""PipeWise API 入口（前后端分离：本服务只提供 /api/v1，前端由 nginx 托管 web/dist）。

启动顺序：建表（MVP 用 create_all；迁移见技术方案 §11）→ 起 dispatcher → 挂路由。
"""

from __future__ import annotations

from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

from .api import admin as admin_api
from .api import definitions as definitions_api
from .api import forms as forms_api
from .api import instances as instances_api
from .api import misc as misc_api
from .api import tasks as tasks_api
from .config import settings
from .db import Base, engine as db_engine
from .engine.dispatcher import DispatcherThread
from .engine.errors import ApiError
from .middleware import DBSessionMiddleware


@asynccontextmanager
async def lifespan(app: FastAPI):
    Base.metadata.create_all(bind=db_engine)
    thread = None
    if settings.DISPATCH_INTERVAL_S > 0:
        thread = DispatcherThread()
        thread.start()
    yield
    if thread:
        thread.stop()


app = FastAPI(title="PipeWise", version="0.1.0", lifespan=lifespan)
app.add_middleware(DBSessionMiddleware)


@app.exception_handler(ApiError)
async def api_error_handler(request: Request, exc: ApiError):
    return JSONResponse(
        status_code=exc.status,
        content={"error": {"code": exc.code, "message": exc.message, "details": exc.details}},
    )


for router in (
    misc_api.router,
    definitions_api.router,
    forms_api.router,
    instances_api.router,
    tasks_api.router,
    admin_api.router,
):
    app.include_router(router, prefix="/api/v1")
