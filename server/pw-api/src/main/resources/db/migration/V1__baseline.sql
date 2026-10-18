-- P0 基线：只建一张元数据表，验证 Flyway 与数据库连通。
-- 后续业务表按 P1/P2 的迁移脚本追加，禁止修改已发布的迁移文件。
CREATE TABLE IF NOT EXISTS wf_meta (
    meta_key   VARCHAR(64) PRIMARY KEY,
    meta_value TEXT        NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO wf_meta (meta_key, meta_value)
VALUES ('schema', 'p0-baseline')
ON CONFLICT (meta_key) DO NOTHING;
