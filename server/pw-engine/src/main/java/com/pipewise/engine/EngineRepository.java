package com.pipewise.engine;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pipewise.engine.EngineDtos.InstanceSummary;
import com.pipewise.engine.EngineDtos.NodeState;
import com.pipewise.engine.EngineDtos.TaskView;
import com.pipewise.engine.EngineDtos.TimelineItem;
import org.postgresql.util.PGobject;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.Array;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

@Repository
public class EngineRepository {

    private static final String INSTANCE_SELECT = """
            SELECT i.id, i.tenant_id, i.definition_id, i.definition_key, i.version_id,
                   i.snapshot_hash, i.business_key, i.title, i.initiator, i.status,
                   i.outcome, i.round, i.step_count, i.state_version, i.created_at, i.ended_at,
                   v.version,
                   COALESCE((SELECT array_agg(t.node_id)
                             FROM wf_token t
                             WHERE t.instance_id = i.id AND t.status IN ('ACTIVE', 'WAITING')),
                            '{}') AS current_nodes
            FROM wf_instance i
            LEFT JOIN wf_definition_version v ON v.id = i.version_id
            """;

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;

    public EngineRepository(JdbcTemplate jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    // ---------- definition snapshot ----------

    public Optional<DefinitionVersionRow> findCurrentVersion(String tenant, String key) {
        String sql = """
                SELECT d.id AS definition_id, d.def_key, v.id AS version_id, v.version,
                       v.content_hash, v.snapshot_json
                FROM wf_definition d
                JOIN wf_definition_version v ON v.id = d.current_version_id
                WHERE d.tenant_id = ? AND d.def_key = ?
                """;
        return jdbc.query(sql, (rs, rowNum) -> new DefinitionVersionRow(
                rs.getLong("definition_id"),
                rs.getString("def_key"),
                rs.getLong("version_id"),
                rs.getInt("version"),
                rs.getString("content_hash"),
                readJson(rs.getString("snapshot_json"))), tenant, key).stream().findFirst();
    }

    public Optional<DefinitionVersionRow> findVersionById(long versionId) {
        String sql = """
                SELECT d.id AS definition_id, d.def_key, v.id AS version_id, v.version,
                       v.content_hash, v.snapshot_json
                FROM wf_definition_version v
                JOIN wf_definition d ON d.id = v.definition_id
                WHERE v.id = ?
                """;
        return jdbc.query(sql, (rs, rowNum) -> new DefinitionVersionRow(
                rs.getLong("definition_id"),
                rs.getString("def_key"),
                rs.getLong("version_id"),
                rs.getInt("version"),
                rs.getString("content_hash"),
                readJson(rs.getString("snapshot_json"))), versionId).stream().findFirst();
    }

    // ---------- instance ----------

    public void insertInstance(String id,
                               String tenant,
                               long definitionId,
                               String definitionKey,
                               long versionId,
                               String snapshotHash,
                               String businessKey,
                               String title,
                               String initiator) {
        jdbc.update("""
                INSERT INTO wf_instance
                    (id, tenant_id, definition_id, definition_key, version_id, snapshot_hash,
                     business_key, title, initiator, status, started_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'RUNNING', now())
                """, id, tenant, definitionId, definitionKey, versionId, snapshotHash,
                businessKey, title, initiator);
    }

    public Optional<InstanceRow> findInstance(String id) {
        return jdbc.query(INSTANCE_SELECT + " WHERE i.id = ?",
                instanceMapper(), id).stream().findFirst();
    }

    public Optional<InstanceRow> loadInstanceForUpdate(String id) {
        return jdbc.query(INSTANCE_SELECT + " WHERE i.id = ? FOR UPDATE OF i",
                instanceMapper(), id).stream().findFirst();
    }

    public void lockInstanceAdvisory(String instanceId) {
        jdbc.query("SELECT pg_advisory_xact_lock(hashtextextended(?, 0))",
                rs -> null, instanceId);
    }

    public List<InstanceSummary> listInstances(String tenant, String status, String definitionKey) {
        String sql = INSTANCE_SELECT + """
                WHERE i.tenant_id = ?
                  AND (CAST(? AS TEXT) IS NULL OR i.status = ?)
                  AND (CAST(? AS TEXT) IS NULL OR i.definition_key = ?)
                ORDER BY i.created_at DESC
                LIMIT 200
                """;
        return jdbc.query(sql, (rs, rowNum) -> toSummary(rs),
                tenant, status, status, definitionKey, definitionKey);
    }

    public void completeInstance(String id, String outcome) {
        jdbc.update("""
                UPDATE wf_instance
                SET status = 'COMPLETED', outcome = ?, ended_at = now(),
                    state_version = state_version + 1
                WHERE id = ?
                """, outcome, id);
    }

    public void bumpStep(String instanceId) {
        jdbc.update("""
                UPDATE wf_instance
                SET step_count = step_count + 1, state_version = state_version + 1
                WHERE id = ?
                """, instanceId);
    }

    public void insertVariable(String instanceId, String name, Object value, String valueType) {
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement("""
                    INSERT INTO wf_variable (instance_id, scope, name, value_type, value_json)
                    VALUES (?, 'FLOW', ?, ?, ?)
                    ON CONFLICT (instance_id, scope, name)
                    DO UPDATE SET value_json = EXCLUDED.value_json,
                                  value_type = EXCLUDED.value_type,
                                  version = wf_variable.version + 1,
                                  updated_at = now()
                    """);
            ps.setString(1, instanceId);
            ps.setString(2, name);
            ps.setString(3, valueType == null ? "json" : valueType);
            ps.setObject(4, jsonb(objectMapper.valueToTree(value)));
            return ps;
        });
    }

    public Map<String, Object> listVariables(String instanceId) {
        Map<String, Object> result = new LinkedHashMap<>();
        jdbc.query("SELECT name, value_json FROM wf_variable WHERE instance_id = ? AND scope = 'FLOW' ORDER BY name",
                rs -> {
                    result.put(rs.getString("name"), readJson(rs.getString("value_json")));
                }, instanceId);
        return result;
    }

    // ---------- token ----------

    public long insertToken(String instanceId, String nodeId, Long parentTokenId, int round) {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement("""
                    INSERT INTO wf_token (instance_id, node_id, status, parent_token_id, round)
                    VALUES (?, ?, 'ACTIVE', ?, ?)
                    """, new String[]{"id"});
            ps.setString(1, instanceId);
            ps.setString(2, nodeId);
            if (parentTokenId == null) {
                ps.setNull(3, java.sql.Types.BIGINT);
            } else {
                ps.setLong(3, parentTokenId);
            }
            ps.setInt(4, round);
            return ps;
        }, keys);
        return keys.getKey() == null ? 0L : keys.getKey().longValue();
    }

    public Optional<TokenRow> loadTokenForUpdate(long tokenId) {
        return jdbc.query("""
                SELECT id, instance_id, node_id, status, parent_token_id, round
                FROM wf_token WHERE id = ? FOR UPDATE
                """, (rs, rowNum) -> new TokenRow(
                rs.getLong("id"),
                rs.getString("instance_id"),
                rs.getString("node_id"),
                rs.getString("status"),
                nullableLong(rs, "parent_token_id"),
                rs.getInt("round")), tokenId).stream().findFirst();
    }

    public void updateTokenStatus(long tokenId, String status) {
        jdbc.update("""
                UPDATE wf_token
                SET status = ?,
                    consumed_at = CASE WHEN ? = 'CONSUMED' THEN now() ELSE consumed_at END
                WHERE id = ?
                """, status, status, tokenId);
    }

    public int countOpenTokens(String instanceId) {
        Integer count = jdbc.queryForObject("""
                SELECT count(*) FROM wf_token
                WHERE instance_id = ? AND status IN ('ACTIVE', 'WAITING')
                """, Integer.class, instanceId);
        return count == null ? 0 : count;
    }

    public void cancelOpenTokens(String instanceId) {
        jdbc.update("""
                UPDATE wf_token SET status = 'CANCELLED'
                WHERE instance_id = ? AND status IN ('ACTIVE', 'WAITING')
                """, instanceId);
    }

    // ---------- node instance ----------

    public long insertNodeInstance(String instanceId, String nodeId, String nodeType, long tokenId) {
        Integer seq = jdbc.queryForObject("""
                SELECT COALESCE(MAX(activation_seq), 0) + 1
                FROM wf_node_instance WHERE instance_id = ? AND node_id = ?
                """, Integer.class, instanceId, nodeId);
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement("""
                    INSERT INTO wf_node_instance
                        (instance_id, node_id, node_type, token_id, activation_seq, status)
                    VALUES (?, ?, ?, ?, ?, 'ACTIVE')
                    """, new String[]{"id"});
            ps.setString(1, instanceId);
            ps.setString(2, nodeId);
            ps.setString(3, nodeType);
            ps.setLong(4, tokenId);
            ps.setInt(5, seq == null ? 1 : seq);
            return ps;
        }, keys);
        return keys.getKey() == null ? 0L : keys.getKey().longValue();
    }

    public Optional<Long> findNodeInstanceByToken(long tokenId) {
        return jdbc.query("SELECT id FROM wf_node_instance WHERE token_id = ? LIMIT 1",
                (rs, rowNum) -> rs.getLong("id"), tokenId).stream().findFirst();
    }

    public Optional<NodeRow> loadNodeInstance(long id) {
        return jdbc.query("""
                SELECT id, instance_id, node_id, node_type, status, token_id, activation_seq
                FROM wf_node_instance WHERE id = ?
                """, (rs, rowNum) -> new NodeRow(
                rs.getLong("id"),
                rs.getString("instance_id"),
                rs.getString("node_id"),
                rs.getString("node_type"),
                rs.getString("status"),
                nullableLong(rs, "token_id"),
                rs.getInt("activation_seq")), id).stream().findFirst();
    }

    public void completeNodeInstance(long id) {
        jdbc.update("""
                UPDATE wf_node_instance SET status = 'COMPLETED', ended_at = now()
                WHERE id = ?
                """, id);
    }

    public void markNodeWaiting(long id) {
        jdbc.update("UPDATE wf_node_instance SET status = 'WAITING' WHERE id = ?", id);
    }

    public List<NodeState> listOpenNodes(String instanceId) {
        return jdbc.query("""
                SELECT id, node_id, node_type, status, token_id, started_at, ended_at
                FROM wf_node_instance
                WHERE instance_id = ? AND status IN ('ACTIVE', 'WAITING')
                ORDER BY id
                """, (rs, rowNum) -> new NodeState(
                rs.getLong("id"),
                rs.getString("node_id"),
                rs.getString("node_type"),
                rs.getString("status"),
                nullableLong(rs, "token_id"),
                instant(rs, "started_at"),
                instant(rs, "ended_at")), instanceId);
    }

    // ---------- job ----------

    public void insertJob(String instanceId, Long nodeInstanceId, String jobType, long tokenId) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("tokenId", tokenId);
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement("""
                    INSERT INTO wf_execution_job
                        (instance_id, node_instance_id, job_type, payload)
                    VALUES (?, ?, ?, ?)
                    """);
            ps.setString(1, instanceId);
            if (nodeInstanceId == null) {
                ps.setNull(2, java.sql.Types.BIGINT);
            } else {
                ps.setLong(2, nodeInstanceId);
            }
            ps.setString(3, jobType);
            ps.setObject(4, jsonb(payload));
            return ps;
        });
    }

    public List<JobRow> claimJobs(String workerId, int limit) {
        return jdbc.query("""
                WITH picked AS (
                    SELECT id FROM wf_execution_job
                    WHERE status = 'PENDING' AND available_at <= now()
                    ORDER BY priority, id
                    LIMIT ?
                    FOR UPDATE SKIP LOCKED
                )
                UPDATE wf_execution_job j
                SET status = 'RUNNING',
                    worker_id = ?,
                    lease_until = now() + interval '30 seconds',
                    attempts = attempts + 1,
                    updated_at = now()
                FROM picked
                WHERE j.id = picked.id
                RETURNING j.id, j.instance_id, j.payload
                """, (rs, rowNum) -> {
            JsonNode payload = readJson(rs.getString("payload"));
            return new JobRow(
                    rs.getLong("id"),
                    rs.getString("instance_id"),
                    payload.path("tokenId").asLong());
        }, limit, workerId);
    }

    public void markJobDone(long id) {
        jdbc.update("""
                UPDATE wf_execution_job
                SET status = 'DONE', lease_until = NULL, worker_id = NULL, updated_at = now()
                WHERE id = ?
                """, id);
    }

    public void markJobFailed(long id, String error) {
        jdbc.update("""
                UPDATE wf_execution_job
                SET status = CASE WHEN attempts >= max_attempts THEN 'DEAD' ELSE 'PENDING' END,
                    available_at = now() + interval '5 seconds',
                    lease_until = NULL,
                    worker_id = NULL,
                    last_error = ?,
                    updated_at = now()
                WHERE id = ?
                """, truncate(error), id);
    }

    public int requeueExpired() {
        return jdbc.update("""
                UPDATE wf_execution_job
                SET status = 'PENDING', available_at = now(),
                    lease_until = NULL, worker_id = NULL, updated_at = now()
                WHERE status = 'RUNNING' AND lease_until < now()
                """);
    }

    // ---------- task ----------

    public long insertTask(String tenant,
                           String instanceId,
                           long nodeInstanceId,
                           String nodeId,
                           String assignee,
                           String title) {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement("""
                    INSERT INTO wf_task
                        (tenant_id, instance_id, node_instance_id, node_id, task_kind,
                         assignee, assignee_type, status, title_snapshot)
                    VALUES (?, ?, ?, ?, 'APPROVAL', ?, 'user', 'CREATED', ?)
                    """, new String[]{"id"});
            ps.setString(1, tenant);
            ps.setString(2, instanceId);
            ps.setLong(3, nodeInstanceId);
            ps.setString(4, nodeId);
            ps.setString(5, assignee);
            ps.setString(6, title);
            return ps;
        }, keys);
        return keys.getKey() == null ? 0L : keys.getKey().longValue();
    }

    public List<TaskView> listTasks(String assignee, String status) {
        return jdbc.query("""
                SELECT id, instance_id, node_id, assignee, status, verdict, comment,
                       title_snapshot, created_at, completed_at
                FROM wf_task
                WHERE assignee = ?
                  AND (CAST(? AS TEXT) IS NULL OR status = ?)
                ORDER BY created_at DESC
                LIMIT 200
                """, (rs, rowNum) -> taskView(rs), assignee, status, status);
    }

    public Optional<TaskRow> findTask(long id) {
        return jdbc.query("""
                SELECT id, instance_id, node_instance_id, node_id, assignee,
                       status, verdict, comment, title_snapshot, version
                FROM wf_task WHERE id = ?
                """, (rs, rowNum) -> taskRow(rs), id).stream().findFirst();
    }

    public Optional<TaskView> findTaskView(long id) {
        return jdbc.query("""
                SELECT id, instance_id, node_id, assignee, status, verdict, comment,
                       title_snapshot, created_at, completed_at
                FROM wf_task WHERE id = ?
                """, (rs, rowNum) -> taskView(rs), id).stream().findFirst();
    }

    public Optional<TaskRow> findTaskForUpdate(long id) {
        return jdbc.query("""
                SELECT id, instance_id, node_instance_id, node_id, assignee,
                       status, verdict, comment, title_snapshot, version
                FROM wf_task WHERE id = ? FOR UPDATE
                """, (rs, rowNum) -> taskRow(rs), id).stream().findFirst();
    }

    public int completeTask(long id, String verdict, String comment) {
        return jdbc.update("""
                UPDATE wf_task
                SET status = 'COMPLETED', verdict = ?, comment = ?,
                    completed_at = now(), version = version + 1
                WHERE id = ? AND status = 'CREATED'
                """, verdict, comment, id);
    }

    public void cancelTasks(String instanceId) {
        jdbc.update("""
                UPDATE wf_task SET status = 'CANCELLED'
                WHERE instance_id = ? AND status = 'CREATED'
                """, instanceId);
    }

    public List<TaskView> listInstanceTasks(String instanceId) {
        return jdbc.query("""
                SELECT id, instance_id, node_id, assignee, status, verdict, comment,
                       title_snapshot, created_at, completed_at
                FROM wf_task WHERE instance_id = ? ORDER BY created_at
                """, (rs, rowNum) -> taskView(rs), instanceId);
    }

    // ---------- audit / outbox ----------

    public void audit(String tenant, String instanceId, String action, String actor, JsonNode detail) {
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement("""
                    INSERT INTO wf_audit_log
                        (tenant_id, instance_id, action, actor, actor_type, detail)
                    VALUES (?, ?, ?, ?, 'user', ?)
                    """);
            ps.setString(1, tenant);
            ps.setString(2, instanceId);
            ps.setString(3, action);
            ps.setString(4, actor);
            ps.setObject(5, jsonb(detail == null ? objectMapper.createObjectNode() : detail));
            return ps;
        });
    }

    public void outbox(String tenant, String aggregateId, String eventType, JsonNode payload) {
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement("""
                    INSERT INTO wf_event_outbox
                        (tenant_id, aggregate_type, aggregate_id, event_type, payload)
                    VALUES (?, 'INSTANCE', ?, ?, ?)
                    """);
            ps.setString(1, tenant);
            ps.setString(2, aggregateId);
            ps.setString(3, eventType);
            ps.setObject(4, jsonb(payload == null ? objectMapper.createObjectNode() : payload));
            return ps;
        });
    }

    public List<TimelineItem> timeline(String instanceId) {
        return jdbc.query("""
                SELECT action, actor, detail, created_at
                FROM wf_audit_log
                WHERE instance_id = ?
                ORDER BY created_at DESC
                LIMIT 200
                """, (rs, rowNum) -> new TimelineItem(
                rs.getString("action"),
                rs.getString("actor"),
                readJson(rs.getString("detail")),
                instant(rs, "created_at")), instanceId);
    }

    // ---------- helpers ----------

    private RowMapper<InstanceRow> instanceMapper() {
        return (rs, rowNum) -> new InstanceRow(
                rs.getString("id"),
                rs.getString("tenant_id"),
                rs.getLong("definition_id"),
                rs.getString("definition_key"),
                rs.getLong("version_id"),
                rs.getString("snapshot_hash"),
                rs.getString("business_key"),
                rs.getString("title"),
                rs.getString("initiator"),
                rs.getString("status"),
                rs.getString("outcome"),
                rs.getInt("round"),
                rs.getInt("step_count"),
                rs.getLong("state_version"),
                rs.getInt("version"),
                stringList(rs, "current_nodes"),
                instant(rs, "created_at"),
                instant(rs, "ended_at"));
    }

    private InstanceSummary toSummary(ResultSet rs) throws SQLException {
        return new InstanceSummary(
                rs.getString("id"),
                rs.getString("definition_key"),
                rs.getString("business_key"),
                rs.getString("title"),
                rs.getString("initiator"),
                rs.getString("status"),
                rs.getString("outcome"),
                rs.getInt("version"),
                stringList(rs, "current_nodes"),
                instant(rs, "created_at"),
                instant(rs, "ended_at"));
    }

    private TaskRow taskRow(ResultSet rs) throws SQLException {
        return new TaskRow(
                rs.getLong("id"),
                rs.getString("instance_id"),
                rs.getLong("node_instance_id"),
                rs.getString("node_id"),
                rs.getString("assignee"),
                rs.getString("status"),
                rs.getString("verdict"),
                rs.getString("comment"),
                rs.getString("title_snapshot"),
                rs.getInt("version"));
    }

    private TaskView taskView(ResultSet rs) throws SQLException {
        return new TaskView(
                rs.getLong("id"),
                rs.getString("instance_id"),
                rs.getString("node_id"),
                rs.getString("assignee"),
                rs.getString("status"),
                rs.getString("verdict"),
                rs.getString("comment"),
                rs.getString("title_snapshot"),
                instant(rs, "created_at"),
                instant(rs, "completed_at"));
    }

    private PGobject jsonb(JsonNode node) throws SQLException {
        PGobject pg = new PGobject();
        pg.setType("jsonb");
        try {
            pg.setValue(objectMapper.writeValueAsString(node == null ? objectMapper.createObjectNode() : node));
        } catch (JsonProcessingException ex) {
            throw new SQLException("cannot serialize json", ex);
        }
        return pg;
    }

    private JsonNode readJson(String value) {
        try {
            return objectMapper.readTree(value == null ? "{}" : value);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("cannot parse json", ex);
        }
    }

    private List<String> stringList(ResultSet rs, String column) throws SQLException {
        Array array = rs.getArray(column);
        if (array == null) {
            return List.of();
        }
        String[] values = (String[]) array.getArray();
        List<String> result = new ArrayList<>(values.length);
        for (String value : values) {
            result.add(value);
        }
        return result;
    }

    private Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp value = rs.getTimestamp(column);
        return value == null ? null : value.toInstant();
    }

    private Long nullableLong(ResultSet rs, String column) throws SQLException {
        long value = rs.getLong(column);
        return rs.wasNull() ? null : value;
    }

    private String truncate(String value) {
        if (value == null) {
            return null;
        }
        return value.length() > 1000 ? value.substring(0, 1000) : value;
    }

    public record DefinitionVersionRow(
            long definitionId,
            String definitionKey,
            long versionId,
            int version,
            String contentHash,
            JsonNode snapshot) {
    }

    public record InstanceRow(
            String id,
            String tenantId,
            long definitionId,
            String definitionKey,
            long versionId,
            String snapshotHash,
            String businessKey,
            String title,
            String initiator,
            String status,
            String outcome,
            int round,
            int stepCount,
            long stateVersion,
            int version,
            List<String> currentNodeIds,
            Instant createdAt,
            Instant endedAt) {
    }

    public record TokenRow(
            long id,
            String instanceId,
            String nodeId,
            String status,
            Long parentTokenId,
            int round) {
    }

    public record NodeRow(
            long id,
            String instanceId,
            String nodeId,
            String nodeType,
            String status,
            Long tokenId,
            int activationSeq) {
    }

    public record JobRow(long id, String instanceId, long tokenId) {
    }

    public record TaskRow(
            long id,
            String instanceId,
            long nodeInstanceId,
            String nodeId,
            String assignee,
            String status,
            String verdict,
            String comment,
            String title,
            int version) {
    }
}
