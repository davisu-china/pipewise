"""数据模型（PRD §16）。

约定：
- 所有表 `wf_` 前缀；时间统一 UTC（`datetime.now(timezone.utc)`）。
- 流程级变量用 `node_instance_id = 0` 作为哨兵（Postgres 的唯一约束把 NULL 视为互不相等，
  用 0 才能让 `unique(instance_id, scope, node_instance_id, name)` 生效）。
- JSON 字段一律 JSONB，便于检索。
"""

from datetime import datetime, timezone

from sqlalchemy import (
    BigInteger,
    Boolean,
    DateTime,
    Float,
    ForeignKey,
    Index,
    Integer,
    String,
    Text,
    UniqueConstraint,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from .db import Base


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


# ---------------------------------------------------------------- 组织（MVP 简化）
class User(Base):
    __tablename__ = "wf_user"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    dept_id: Mapped[str | None] = mapped_column(String(64))
    manager_id: Mapped[str | None] = mapped_column(String(64))
    roles: Mapped[list] = mapped_column(JSONB, default=list, nullable=False)
    token: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    active: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)


class Dept(Base):
    __tablename__ = "wf_dept"

    id: Mapped[str] = mapped_column(String(64), primary_key=True)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    leader_id: Mapped[str | None] = mapped_column(String(64))
    parent_id: Mapped[str | None] = mapped_column(String(64))


# ---------------------------------------------------------------- 定义与版本
class Definition(Base):
    __tablename__ = "wf_definition"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str | None] = mapped_column(String(64))
    description: Mapped[str | None] = mapped_column(Text)
    status: Mapped[str] = mapped_column(String(16), default="active", nullable=False)  # active|retired
    tenant: Mapped[str] = mapped_column(String(64), default="default", nullable=False)

    # 草稿：可编辑；发布时生成不可变版本
    draft_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    draft_rev: Mapped[int] = mapped_column(Integer, default=1, nullable=False)

    current_version_id: Mapped[int | None] = mapped_column(BigInteger)
    created_by: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class Version(Base):
    """流程版本：发布后不可变（PRD §6.2）。"""

    __tablename__ = "wf_version"
    __table_args__ = (UniqueConstraint("definition_id", "version", name="uq_version_no"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    definition_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("wf_definition.id"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    snapshot_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="DRAFT", nullable=False)  # DRAFT|SUBMITTED|PUBLISHED|RETIRED
    submitted_by: Mapped[str | None] = mapped_column(String(64))
    submitted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_by: Mapped[str | None] = mapped_column(String(64))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


# ---------------------------------------------------------------- 实例与执行
class Instance(Base):
    __tablename__ = "wf_instance"
    __table_args__ = (
        UniqueConstraint("definition_id", "business_key", name="uq_instance_business_key"),
        Index("ix_instance_status_started", "status", "started_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    definition_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("wf_definition.id"), nullable=False)
    version_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("wf_version.id"), nullable=False)
    definition_key: Mapped[str] = mapped_column(String(128), nullable=False)
    business_key: Mapped[str] = mapped_column(String(128), nullable=False)
    title: Mapped[str | None] = mapped_column(String(300))
    initiator: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="CREATED", nullable=False)
    outcome: Mapped[str | None] = mapped_column(String(16))
    step_count: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    resubmit_mode: Mapped[str] = mapped_column(String(16), default="restart", nullable=False)
    dry_run: Mapped[bool] = mapped_column(Boolean, default=False, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    started_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Token(Base):
    """令牌：执行游标（PRD §9.2）。"""

    __tablename__ = "wf_token"
    __table_args__ = (Index("ix_token_instance_status", "instance_id", "status"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instance_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("wf_instance.id"), nullable=False)
    node_id: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="ACTIVE", nullable=False)  # ACTIVE|WAITING|CONSUMED
    parent_token_id: Mapped[int | None] = mapped_column(BigInteger)
    # join 汇聚时记录"从哪条边来的"，用来按入边计数（同一入边每轮只贡献一次）
    arrived_edge: Mapped[str | None] = mapped_column(String(64))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class NodeInstance(Base):
    """一次节点激活（并行时同一节点可多次激活）。"""

    __tablename__ = "wf_node_instance"
    __table_args__ = (Index("ix_node_instance_instance", "instance_id", "node_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instance_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("wf_instance.id"), nullable=False)
    node_id: Mapped[str] = mapped_column(String(64), nullable=False)
    node_type: Mapped[str] = mapped_column(String(32), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="RUNNING", nullable=False)
    token_id: Mapped[int | None] = mapped_column(BigInteger)
    activation_seq: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    attempt: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    # 节点局部变量（PRD §11.1）：节点结束即归档，不删
    local_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    result_json: Mapped[dict | None] = mapped_column(JSONB)
    error: Mapped[str | None] = mapped_column(Text)
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class Task(Base):
    __tablename__ = "wf_task"
    __table_args__ = (
        UniqueConstraint("node_instance_id", "assignee", name="uq_task_assignee"),
        Index("ix_task_assignee_status", "assignee", "status"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instance_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("wf_instance.id"), nullable=False)
    node_instance_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("wf_node_instance.id"), nullable=False)
    node_id: Mapped[str] = mapped_column(String(64), nullable=False)
    kind: Mapped[str] = mapped_column(String(16), default="approval", nullable=False)  # approval|form|resubmit
    assignee: Mapped[str] = mapped_column(String(64), nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="CREATED", nullable=False)  # CREATED|CLAIMED|COMPLETED|CANCELLED
    verdict: Mapped[str | None] = mapped_column(String(16))
    comment: Mapped[str | None] = mapped_column(Text)
    form_data: Mapped[dict | None] = mapped_column(JSONB)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    claimed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# ---------------------------------------------------------------- 上下文
class Variable(Base):
    __tablename__ = "wf_variable"
    __table_args__ = (
        UniqueConstraint("instance_id", "scope", "node_instance_id", "name", name="uq_variable"),
    )

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instance_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("wf_instance.id"), nullable=False)
    scope: Mapped[str] = mapped_column(String(16), default="process", nullable=False)  # process|local
    node_instance_id: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    type: Mapped[str] = mapped_column(String(16), default="json", nullable=False)
    value_json: Mapped[object] = mapped_column(JSONB, nullable=True)
    version: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, onupdate=utcnow, nullable=False)


class VariableLog(Base):
    __tablename__ = "wf_variable_log"
    __table_args__ = (Index("ix_varlog_instance_time", "instance_id", "created_at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instance_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    node_instance_id: Mapped[int] = mapped_column(BigInteger, default=0, nullable=False)
    name: Mapped[str] = mapped_column(String(128), nullable=False)
    old_value: Mapped[object] = mapped_column(JSONB, nullable=True)
    new_value: Mapped[object] = mapped_column(JSONB, nullable=True)
    actor: Mapped[str] = mapped_column(String(64), nullable=False)
    actor_type: Mapped[str] = mapped_column(String(16), default="user", nullable=False)  # user|script|system|admin
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


# ---------------------------------------------------------------- 表单
class Form(Base):
    __tablename__ = "wf_form"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    key: Mapped[str] = mapped_column(String(128), unique=True, nullable=False)
    name: Mapped[str] = mapped_column(String(200), nullable=False)
    category: Mapped[str | None] = mapped_column(String(64))
    draft_schema: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    draft_rev: Mapped[int] = mapped_column(Integer, default=1, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class FormVersion(Base):
    __tablename__ = "wf_form_version"
    __table_args__ = (UniqueConstraint("form_id", "version", name="uq_form_version_no"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    form_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("wf_form.id"), nullable=False)
    version: Mapped[int] = mapped_column(Integer, nullable=False)
    schema_json: Mapped[dict] = mapped_column(JSONB, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="PUBLISHED", nullable=False)
    published_by: Mapped[str | None] = mapped_column(String(64))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class FormBinding(Base):
    """节点 × 表单版本 × 字段权限矩阵（PRD §10.2 / §16）。

    快照里 `formRef + fieldPermissions` 是权威来源；发布时物化到这张表，
    便于运维查询「哪些节点用了哪张表单」。
    """

    __tablename__ = "wf_form_binding"
    __table_args__ = (UniqueConstraint("version_id", "node_id", name="uq_form_binding"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    version_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("wf_version.id"), nullable=False)
    node_id: Mapped[str] = mapped_column(String(64), nullable=False)
    form_version_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("wf_form_version.id"), nullable=False)
    field_permissions_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)


class FormData(Base):
    __tablename__ = "wf_form_data"
    __table_args__ = (Index("ix_form_data_instance", "instance_id"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instance_id: Mapped[int] = mapped_column(BigInteger, ForeignKey("wf_instance.id"), nullable=False)
    node_instance_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    task_id: Mapped[int | None] = mapped_column(BigInteger)
    form_version_id: Mapped[int | None] = mapped_column(BigInteger)
    data_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    indexed_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


# ---------------------------------------------------------------- 事件 / 审计 / 幂等
class Outbox(Base):
    __tablename__ = "wf_event_outbox"
    __table_args__ = (Index("ix_outbox_status_retry", "status", "next_retry_at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instance_id: Mapped[int | None] = mapped_column(BigInteger)
    type: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", nullable=False)  # PENDING|DELIVERED|DEAD
    attempts: Mapped[int] = mapped_column(Integer, default=0, nullable=False)
    next_retry_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)
    delivered_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


class AuditLog(Base):
    __tablename__ = "wf_audit_log"
    __table_args__ = (Index("ix_audit_instance_time", "instance_id", "created_at"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instance_id: Mapped[int | None] = mapped_column(BigInteger)
    node_instance_id: Mapped[int | None] = mapped_column(BigInteger)
    action: Mapped[str] = mapped_column(String(64), nullable=False)
    actor: Mapped[str] = mapped_column(String(64), nullable=False)
    detail_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class IdempotencyKey(Base):
    __tablename__ = "wf_idempotency"
    __table_args__ = (UniqueConstraint("scope", "key", name="uq_idempotency"),)

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    scope: Mapped[str] = mapped_column(String(128), nullable=False)
    key: Mapped[str] = mapped_column(String(200), nullable=False)
    user_id: Mapped[str | None] = mapped_column(String(64))
    response_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class Webhook(Base):
    __tablename__ = "wf_webhook"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    definition_key: Mapped[str | None] = mapped_column(String(128))  # 空 = 全局
    url: Mapped[str] = mapped_column(String(500), nullable=False)
    secret: Mapped[str] = mapped_column(String(128), default="", nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


class DevSink(Base):
    """演示用回调接收器：记录投递过来的 webhook（生产不会用）。"""

    __tablename__ = "wf_dev_sink"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    event_type: Mapped[str] = mapped_column(String(64), nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    signature: Mapped[str | None] = mapped_column(String(200))
    received_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), default=utcnow, nullable=False)


# ---------------------------------------------------------------- 预留（P1）
class Timer(Base):
    """P1：定时/超时。表和模型先留着，MVP 不写入（见技术方案 §11）。"""

    __tablename__ = "wf_timer"

    id: Mapped[int] = mapped_column(BigInteger, primary_key=True, autoincrement=True)
    instance_id: Mapped[int] = mapped_column(BigInteger, nullable=False)
    node_instance_id: Mapped[int | None] = mapped_column(BigInteger)
    fire_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    type: Mapped[str] = mapped_column(String(32), default="timeout", nullable=False)
    payload_json: Mapped[dict] = mapped_column(JSONB, default=dict, nullable=False)
    status: Mapped[str] = mapped_column(String(16), default="PENDING", nullable=False)
