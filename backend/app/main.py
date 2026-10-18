"""PipeWise API 入口。

启动顺序：建表（MVP 用 create_all；迁移见技术方案 §11）→ 起 dispatcher → 挂路由与静态页。
"""

from __future__ import annotations

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles

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

STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "static")


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


@app.middleware("http")
async def no_cache_static(request, call_next):
    """SPA 外壳与静态资源一律 no-cache（带 ETag 复验）。

    没有构建步骤、文件名不带内容哈希，如果放任浏览器按 Last-Modified 做启发式缓存，
    改完前端用户可能几小时都看不到新版本（本项目线上踩过：页面白屏，其实是旧 app.js）。
    """
    response = await call_next(request)
    path = request.url.path
    if path in ("/", "/index.html") or path.endswith((".js", ".css")):
        response.headers["Cache-Control"] = "no-cache"
    return response


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

if os.path.isdir(STATIC_DIR):
    app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
