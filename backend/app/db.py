"""数据库会话。

MVP 用 SQLAlchemy 同步 ORM + psycopg3：引擎的事务边界就是请求的事务边界，
这样「状态转移 + 事件入 outbox」天然同事务（PRD §14.1）。
"""

from contextlib import contextmanager

from fastapi import Request
from sqlalchemy import create_engine
from sqlalchemy.orm import DeclarativeBase, Session, sessionmaker

from .config import settings

engine = create_engine(
    settings.DATABASE_URL,
    pool_pre_ping=True,
    pool_size=10,
    max_overflow=20,
    future=True,
)

SessionLocal = sessionmaker(bind=engine, autoflush=False, expire_on_commit=False, future=True)


class Base(DeclarativeBase):
    pass


def get_session(request: Request) -> Session:
    """FastAPI 依赖：会话由 `DBSessionMiddleware` 在**响应发出之前**提交（见 middleware.py）。

    不用 yield 依赖在这里 commit：FastAPI 的 yield 清理由响应发送之后才执行，
    客户端紧接着读会读到未提交的旧状态（本项目实测踩过）。
    """
    return request.state.db


@contextmanager
def session_scope():
    """非请求上下文（dispatcher/脚本/seed）用。"""
    session = SessionLocal()
    try:
        yield session
        session.commit()
    except Exception:
        session.rollback()
        raise
    finally:
        session.close()
