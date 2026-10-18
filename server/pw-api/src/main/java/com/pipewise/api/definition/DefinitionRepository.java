package com.pipewise.api.definition;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ArrayNode;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pipewise.api.definition.DefinitionDtos.DefinitionDetail;
import com.pipewise.api.definition.DefinitionDtos.DefinitionSummary;
import com.pipewise.api.definition.DefinitionDtos.VersionDetail;
import com.pipewise.api.definition.DefinitionDtos.VersionSummary;
import org.postgresql.util.PGobject;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.jdbc.core.RowMapper;
import org.springframework.jdbc.support.GeneratedKeyHolder;
import org.springframework.jdbc.support.KeyHolder;
import org.springframework.stereotype.Repository;

import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.time.Instant;
import java.util.List;
import java.util.Optional;

@Repository
public class DefinitionRepository {

    private static final String SELECT_DEFINITION = """
            SELECT d.id, d.def_key, d.name, d.category, d.description, d.status,
                   d.draft_rev, d.draft_json, d.created_at, d.updated_at,
                   v.version AS current_version
            FROM wf_definition d
            LEFT JOIN wf_definition_version v ON v.id = d.current_version_id
            """;

    private final JdbcTemplate jdbc;
    private final ObjectMapper objectMapper;

    public DefinitionRepository(JdbcTemplate jdbc, ObjectMapper objectMapper) {
        this.jdbc = jdbc;
        this.objectMapper = objectMapper;
    }

    public List<DefinitionSummary> list(String tenant, String keyword) {
        String base = """
                SELECT d.id, d.def_key, d.name, d.category, d.description, d.status,
                       d.draft_rev, d.updated_at, v.version AS current_version
                FROM wf_definition d
                LEFT JOIN wf_definition_version v ON v.id = d.current_version_id
                WHERE d.tenant_id = ?
                """;
        RowMapper<DefinitionSummary> mapper = (rs, rowNum) -> new DefinitionSummary(
                rs.getLong("id"),
                rs.getString("def_key"),
                rs.getString("name"),
                rs.getString("category"),
                rs.getString("description"),
                rs.getString("status"),
                nullableInt(rs, "current_version"),
                rs.getInt("draft_rev"),
                instant(rs, "updated_at"));

        if (keyword == null || keyword.isBlank()) {
            return jdbc.query(base + " ORDER BY d.updated_at DESC", mapper, tenant);
        }
        String like = "%" + keyword.trim() + "%";
        return jdbc.query(base + " AND (d.def_key ILIKE ? OR d.name ILIKE ?) ORDER BY d.updated_at DESC",
                mapper, tenant, like, like);
    }

    public Optional<DefinitionDetail> find(String tenant, String key) {
        List<DefinitionDetail> rows = jdbc.query(
                SELECT_DEFINITION + " WHERE d.tenant_id = ? AND d.def_key = ?",
                detailMapper(), tenant, key);
        return rows.stream().findFirst();
    }

    public DefinitionDetail create(String tenant, DefinitionDtos.CreateRequest request, String actor) {
        JsonNode draft = defaultDraft(tenant, request.key(), request.name());
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement("""
                    INSERT INTO wf_definition
                        (tenant_id, def_key, name, category, description, status,
                         draft_json, draft_rev, created_by, updated_at)
                    VALUES (?, ?, ?, ?, ?, 'ACTIVE', ?, 1, ?, now())
                    """, new String[]{"id"});
            ps.setString(1, tenant);
            ps.setString(2, request.key());
            ps.setString(3, request.name());
            ps.setString(4, request.category());
            ps.setString(5, request.description());
            ps.setObject(6, jsonb(draft));
            ps.setString(7, actor);
            return ps;
        }, keys);

        return find(tenant, request.key())
                .orElseThrow(() -> new IllegalStateException("definition insert failed"));
    }

    public int saveDraft(String tenant, String key, int expectedRev, JsonNode draft) {
        return jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement("""
                    UPDATE wf_definition
                    SET draft_json = ?, draft_rev = draft_rev + 1, updated_at = now()
                    WHERE tenant_id = ? AND def_key = ? AND draft_rev = ?
                    """);
            ps.setObject(1, jsonb(draft));
            ps.setString(2, tenant);
            ps.setString(3, key);
            ps.setInt(4, expectedRev);
            return ps;
        });
    }

    public Optional<LockedDefinition> findForUpdate(String tenant, String key) {
        List<LockedDefinition> rows = jdbc.query("""
                SELECT id, def_key, name, draft_json, draft_rev
                FROM wf_definition
                WHERE tenant_id = ? AND def_key = ?
                FOR UPDATE
                """, (rs, rowNum) -> new LockedDefinition(
                rs.getLong("id"),
                rs.getString("def_key"),
                rs.getString("name"),
                readJson(rs.getString("draft_json")),
                rs.getInt("draft_rev")), tenant, key);
        return rows.stream().findFirst();
    }

    public int nextVersion(long definitionId) {
        Integer next = jdbc.queryForObject("""
                SELECT COALESCE(MAX(version), 0) + 1
                FROM wf_definition_version
                WHERE definition_id = ?
                """, Integer.class, definitionId);
        return next == null ? 1 : next;
    }

    public VersionSummary insertVersion(long definitionId,
                                        int version,
                                        JsonNode snapshot,
                                        String contentHash,
                                        JsonNode variablesSchema,
                                        String actor,
                                        String changeSummary) {
        KeyHolder keys = new GeneratedKeyHolder();
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement("""
                    INSERT INTO wf_definition_version
                        (definition_id, version, snapshot_json, content_hash, variables_schema,
                         status, change_summary, submitted_by, submitted_at, published_by, published_at)
                    VALUES (?, ?, ?, ?, ?, 'PUBLISHED', ?, ?, now(), ?, now())
                    """, new String[]{"id"});
            ps.setLong(1, definitionId);
            ps.setInt(2, version);
            ps.setObject(3, jsonb(snapshot));
            ps.setString(4, contentHash);
            ps.setObject(5, jsonb(variablesSchema));
            ps.setString(6, changeSummary);
            ps.setString(7, actor);
            ps.setString(8, actor);
            return ps;
        }, keys);

        long id = keys.getKey() == null ? 0L : keys.getKey().longValue();
        return findVersion(definitionId, version)
                .map(detail -> new VersionSummary(
                        id == 0 ? detail.id() : id,
                        detail.version(),
                        detail.contentHash(),
                        detail.status(),
                        detail.changeSummary(),
                        detail.publishedBy(),
                        detail.publishedAt()))
                .orElseThrow(() -> new IllegalStateException("version insert failed"));
    }

    public void updateCurrentVersion(long definitionId, long versionId) {
        jdbc.update("""
                UPDATE wf_definition
                SET current_version_id = ?, updated_at = now()
                WHERE id = ?
                """, versionId, definitionId);
    }

    public List<VersionSummary> listVersions(long definitionId) {
        return jdbc.query("""
                SELECT id, version, content_hash, status, change_summary, published_by, published_at
                FROM wf_definition_version
                WHERE definition_id = ?
                ORDER BY version DESC
                """, (rs, rowNum) -> new VersionSummary(
                rs.getLong("id"),
                rs.getInt("version"),
                rs.getString("content_hash"),
                rs.getString("status"),
                rs.getString("change_summary"),
                rs.getString("published_by"),
                instant(rs, "published_at")), definitionId);
    }

    public Optional<VersionDetail> findVersion(long definitionId, int version) {
        List<VersionDetail> rows = jdbc.query("""
                SELECT id, version, snapshot_json, content_hash, status,
                       change_summary, published_by, published_at
                FROM wf_definition_version
                WHERE definition_id = ? AND version = ?
                """, (rs, rowNum) -> new VersionDetail(
                rs.getLong("id"),
                rs.getInt("version"),
                readJson(rs.getString("snapshot_json")),
                rs.getString("content_hash"),
                rs.getString("status"),
                rs.getString("change_summary"),
                rs.getString("published_by"),
                instant(rs, "published_at")), definitionId, version);
        return rows.stream().findFirst();
    }

    public Optional<Long> findVersionId(long definitionId, int version) {
        return jdbc.query("""
                SELECT id FROM wf_definition_version
                WHERE definition_id = ? AND version = ?
                """, (rs, rowNum) -> rs.getLong("id"), definitionId, version)
                .stream().findFirst();
    }

    public Optional<Long> findDefinitionId(String tenant, String key) {
        return jdbc.query("""
                SELECT id FROM wf_definition WHERE tenant_id = ? AND def_key = ?
                """, (rs, rowNum) -> rs.getLong("id"), tenant, key)
                .stream().findFirst();
    }

    public void audit(String tenant, String action, String actor, JsonNode detail) {
        jdbc.update(connection -> {
            PreparedStatement ps = connection.prepareStatement("""
                    INSERT INTO wf_audit_log (tenant_id, action, actor, actor_type, detail)
                    VALUES (?, ?, ?, 'user', ?)
                    """);
            ps.setString(1, tenant);
            ps.setString(2, action);
            ps.setString(3, actor);
            ps.setObject(4, jsonb(detail));
            return ps;
        });
    }

    public JsonNode defaultDraft(String tenant, String key, String name) {
        ObjectNode root = objectMapper.createObjectNode();
        root.put("key", key);
        root.put("name", name);
        root.put("tenant", tenant);
        root.putNull("version");

        ObjectNode settings = root.putObject("settings");
        settings.put("maxSteps", 1000);
        settings.put("maxNodeActivations", 100);
        settings.put("timezone", "Asia/Shanghai");
        root.putArray("variables");

        ArrayNode nodes = root.putArray("nodes");
        ObjectNode start = nodes.addObject();
        start.put("id", "start");
        start.put("type", "start");
        start.put("name", "发起");
        ObjectNode startPos = start.putObject("position");
        startPos.put("x", 80);
        startPos.put("y", 160);
        start.putObject("config");

        ObjectNode end = nodes.addObject();
        end.put("id", "end");
        end.put("type", "end");
        end.put("name", "结束");
        ObjectNode endPos = end.putObject("position");
        endPos.put("x", 520);
        endPos.put("y", 160);
        end.putObject("config");

        root.putArray("edges");
        return root;
    }

    private RowMapper<DefinitionDetail> detailMapper() {
        return (rs, rowNum) -> new DefinitionDetail(
                rs.getLong("id"),
                rs.getString("def_key"),
                rs.getString("name"),
                rs.getString("category"),
                rs.getString("description"),
                rs.getString("status"),
                nullableInt(rs, "current_version"),
                rs.getInt("draft_rev"),
                readJson(rs.getString("draft_json")),
                instant(rs, "created_at"),
                instant(rs, "updated_at"));
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

    private Integer nullableInt(ResultSet rs, String column) throws SQLException {
        int value = rs.getInt(column);
        return rs.wasNull() ? null : value;
    }

    private Instant instant(ResultSet rs, String column) throws SQLException {
        Timestamp value = rs.getTimestamp(column);
        return value == null ? null : value.toInstant();
    }

    public record LockedDefinition(long id, String key, String name, JsonNode draft, int draftRev) {
    }
}
