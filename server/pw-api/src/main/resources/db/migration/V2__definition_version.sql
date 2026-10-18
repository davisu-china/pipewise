-- P1：流程定义、不可变版本与发布审计。
CREATE TABLE IF NOT EXISTS wf_definition (
    id                 BIGSERIAL PRIMARY KEY,
    tenant_id          VARCHAR(64)  NOT NULL DEFAULT 'default',
    def_key            VARCHAR(128) NOT NULL,
    name               VARCHAR(200) NOT NULL,
    category           VARCHAR(64),
    description        TEXT,
    status             VARCHAR(16)  NOT NULL DEFAULT 'ACTIVE',
    current_version_id BIGINT,
    draft_json         JSONB        NOT NULL DEFAULT '{}'::jsonb,
    draft_rev          INT          NOT NULL DEFAULT 1,
    created_by         VARCHAR(64),
    created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
    UNIQUE (tenant_id, def_key)
);

CREATE TABLE IF NOT EXISTS wf_definition_version (
    id               BIGSERIAL PRIMARY KEY,
    definition_id    BIGINT      NOT NULL REFERENCES wf_definition(id),
    version          INT         NOT NULL,
    snapshot_json    JSONB       NOT NULL,
    content_hash     CHAR(64)    NOT NULL,
    variables_schema JSONB       NOT NULL DEFAULT '[]'::jsonb,
    status           VARCHAR(16) NOT NULL DEFAULT 'PUBLISHED',
    gray_rule        JSONB,
    change_summary   TEXT,
    submitted_by     VARCHAR(64),
    submitted_at     TIMESTAMPTZ,
    published_by     VARCHAR(64),
    published_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (definition_id, version)
);

CREATE INDEX IF NOT EXISTS ix_definition_current_version
    ON wf_definition(current_version_id);

CREATE TABLE IF NOT EXISTS wf_audit_log (
    id          BIGSERIAL PRIMARY KEY,
    tenant_id   VARCHAR(64) NOT NULL DEFAULT 'default',
    instance_id VARCHAR(40),
    task_id     BIGINT,
    node_id     VARCHAR(64),
    action      VARCHAR(64) NOT NULL,
    actor       VARCHAR(64) NOT NULL,
    actor_type  VARCHAR(16) NOT NULL DEFAULT 'user',
    trace_id    VARCHAR(64),
    detail      JSONB       NOT NULL DEFAULT '{}'::jsonb,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_audit_action
    ON wf_audit_log(tenant_id, action, created_at DESC);
