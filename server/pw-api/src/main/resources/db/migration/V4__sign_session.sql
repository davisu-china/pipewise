-- P3：签核会话（或签 / 并签 / 竞签）与退回策略。
CREATE TABLE IF NOT EXISTS wf_sign_session (
    id                BIGSERIAL PRIMARY KEY,
    instance_id       VARCHAR(40) NOT NULL,
    node_instance_id  BIGINT      NOT NULL,
    node_id           VARCHAR(64) NOT NULL,
    mode              VARCHAR(8)  NOT NULL,
    sign_style        VARCHAR(8)  NOT NULL DEFAULT 'PARALLEL',
    status            VARCHAR(16) NOT NULL DEFAULT 'OPEN',
    decision          VARCHAR(16),
    pass_rule         JSONB       NOT NULL DEFAULT '{"type":"ALL"}'::jsonb,
    reject_rule       VARCHAR(24) NOT NULL DEFAULT 'VETO_IMMEDIATE',
    return_strategy   VARCHAR(24) NOT NULL DEFAULT 'terminate',
    return_target     VARCHAR(64),
    expected_count    INT         NOT NULL,
    completed_count   INT         NOT NULL DEFAULT 0,
    approve_count     INT         NOT NULL DEFAULT 0,
    reject_count      INT         NOT NULL DEFAULT 0,
    turn_index        INT         NOT NULL DEFAULT 1,
    version           INT         NOT NULL DEFAULT 0,
    decided_at        TIMESTAMPTZ,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_sign_session_instance
    ON wf_sign_session(instance_id, status);
CREATE UNIQUE INDEX IF NOT EXISTS ux_sign_session_one_open
    ON wf_sign_session(node_instance_id) WHERE status = 'OPEN';

CREATE INDEX IF NOT EXISTS ix_task_sign_session
    ON wf_task(sign_session_id);
