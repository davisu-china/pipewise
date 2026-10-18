-- P2：实例、令牌、节点实例、作业、任务、变量与事件。
CREATE TABLE IF NOT EXISTS wf_instance (
    id             VARCHAR(40) PRIMARY KEY,
    tenant_id      VARCHAR(64)  NOT NULL DEFAULT 'default',
    definition_id  BIGINT       NOT NULL,
    definition_key VARCHAR(128) NOT NULL,
    version_id     BIGINT       NOT NULL,
    snapshot_hash  CHAR(64)     NOT NULL,
    business_key   VARCHAR(128) NOT NULL,
    title          VARCHAR(300),
    initiator      VARCHAR(64)  NOT NULL,
    status         VARCHAR(16)  NOT NULL,
    outcome        VARCHAR(16),
    round          INT          NOT NULL DEFAULT 1,
    step_count     INT          NOT NULL DEFAULT 0,
    state_version  BIGINT       NOT NULL DEFAULT 0,
    started_at     TIMESTAMPTZ,
    ended_at       TIMESTAMPTZ,
    created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, definition_key, business_key)
);

CREATE INDEX IF NOT EXISTS ix_instance_status ON wf_instance(status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_instance_initiator ON wf_instance(initiator, created_at DESC);

CREATE TABLE IF NOT EXISTS wf_token (
    id              BIGSERIAL PRIMARY KEY,
    instance_id     VARCHAR(40) NOT NULL,
    node_id         VARCHAR(64) NOT NULL,
    status          VARCHAR(16) NOT NULL,
    parent_token_id BIGINT,
    scope_id        BIGINT,
    branch_key      VARCHAR(64),
    round           INT         NOT NULL DEFAULT 1,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
    consumed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS ix_token_instance ON wf_token(instance_id, status);

CREATE TABLE IF NOT EXISTS wf_node_instance (
    id             BIGSERIAL PRIMARY KEY,
    instance_id    VARCHAR(40) NOT NULL,
    node_id        VARCHAR(64) NOT NULL,
    node_type      VARCHAR(32) NOT NULL,
    token_id       BIGINT,
    activation_seq INT         NOT NULL,
    status         VARCHAR(16) NOT NULL,
    local_context  JSONB       NOT NULL DEFAULT '{}'::jsonb,
    round          INT         NOT NULL DEFAULT 1,
    carried_over   BOOLEAN     NOT NULL DEFAULT FALSE,
    error_code     VARCHAR(64),
    error_detail   TEXT,
    started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    ended_at       TIMESTAMPTZ,
    UNIQUE (instance_id, node_id, activation_seq)
);

CREATE INDEX IF NOT EXISTS ix_node_instance_token ON wf_node_instance(token_id);
CREATE INDEX IF NOT EXISTS ix_node_instance_waiting ON wf_node_instance(instance_id, status);

CREATE TABLE IF NOT EXISTS wf_execution_job (
    id               BIGSERIAL PRIMARY KEY,
    tenant_id        VARCHAR(64) NOT NULL DEFAULT 'default',
    instance_id      VARCHAR(40) NOT NULL,
    node_instance_id BIGINT,
    job_type         VARCHAR(32) NOT NULL,
    expected_status  VARCHAR(16),
    payload          JSONB       NOT NULL DEFAULT '{}'::jsonb,
    status           VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    priority         SMALLINT    NOT NULL DEFAULT 100,
    available_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    lease_until      TIMESTAMPTZ,
    worker_id        VARCHAR(64),
    attempts         INT         NOT NULL DEFAULT 0,
    max_attempts     INT         NOT NULL DEFAULT 10,
    last_error       TEXT,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_job_pick ON wf_execution_job(status, available_at, priority)
    WHERE status = 'PENDING';
CREATE INDEX IF NOT EXISTS ix_job_instance ON wf_execution_job(instance_id, status);

CREATE TABLE IF NOT EXISTS wf_task (
    id               BIGSERIAL PRIMARY KEY,
    tenant_id        VARCHAR(64) NOT NULL DEFAULT 'default',
    instance_id      VARCHAR(40) NOT NULL,
    node_instance_id BIGINT      NOT NULL,
    node_id          VARCHAR(64) NOT NULL,
    sign_session_id  BIGINT,
    task_kind        VARCHAR(16) NOT NULL,
    assignee         VARCHAR(64) NOT NULL,
    assignee_type    VARCHAR(16) NOT NULL DEFAULT 'user',
    candidate_group  VARCHAR(128),
    status           VARCHAR(16) NOT NULL,
    verdict          VARCHAR(16),
    comment          TEXT,
    title_snapshot   VARCHAR(300),
    due_at           TIMESTAMPTZ,
    claimed_at       TIMESTAMPTZ,
    completed_at     TIMESTAMPTZ,
    version          INT         NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_task_assignee ON wf_task(assignee, status, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_task_instance ON wf_task(instance_id, created_at);

CREATE TABLE IF NOT EXISTS wf_variable (
    id          BIGSERIAL PRIMARY KEY,
    instance_id VARCHAR(40) NOT NULL,
    scope       VARCHAR(16) NOT NULL DEFAULT 'FLOW',
    name        VARCHAR(128) NOT NULL,
    value_type  VARCHAR(16) NOT NULL DEFAULT 'json',
    value_json  JSONB,
    version     BIGINT      NOT NULL DEFAULT 0,
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (instance_id, scope, name)
);

CREATE TABLE IF NOT EXISTS wf_event_outbox (
    id             BIGSERIAL PRIMARY KEY,
    event_id       UUID        NOT NULL DEFAULT gen_random_uuid(),
    tenant_id      VARCHAR(64) NOT NULL DEFAULT 'default',
    aggregate_type VARCHAR(32) NOT NULL,
    aggregate_id   VARCHAR(64) NOT NULL,
    event_type     VARCHAR(64) NOT NULL,
    payload        JSONB       NOT NULL,
    headers        JSONB,
    status         VARCHAR(16) NOT NULL DEFAULT 'PENDING',
    attempts       INT         NOT NULL DEFAULT 0,
    next_retry_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_error     TEXT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    sent_at        TIMESTAMPTZ,
    UNIQUE (event_id)
);

CREATE INDEX IF NOT EXISTS ix_outbox_pending ON wf_event_outbox(status, next_retry_at)
    WHERE status = 'PENDING';
