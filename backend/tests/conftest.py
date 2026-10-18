"""测试夹具。

需要一个**一次性数据库**（会被 drop_all/create_all 清空）：
    TEST_DATABASE_URL=postgresql+psycopg://mutual@127.0.0.1:5433/pipewise_test
"""

from __future__ import annotations

import os

import pytest

os.environ.setdefault("DISPATCH_INTERVAL_S", "0")  # 测试里不起后台线程
os.environ.setdefault(
    "DATABASE_URL",
    os.getenv("TEST_DATABASE_URL", "postgresql+psycopg://mutual@127.0.0.1:5433/pipewise_test"),
)

from app import seed as seed_module  # noqa: E402
from app.db import Base, SessionLocal, engine  # noqa: E402


@pytest.fixture(scope="session", autouse=True)
def prepare_db():
    Base.metadata.drop_all(bind=engine)
    Base.metadata.create_all(bind=engine)
    seed_module.seed()
    yield


@pytest.fixture()
def session():
    s = SessionLocal()
    try:
        yield s
    finally:
        s.rollback()
        s.close()
