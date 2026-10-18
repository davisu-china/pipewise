package com.pipewise.api.definition;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;

import java.time.Instant;
import java.util.List;

public final class DefinitionDtos {

    private DefinitionDtos() {
    }

    public record CreateRequest(
            @NotBlank
            @Pattern(regexp = "[a-z][a-z0-9_]{2,63}", message = "key 需为 3-64 位小写字母/数字/下划线，且以字母开头")
            String key,
            @NotBlank String name,
            String category,
            String description) {
    }

    public record SaveDraftRequest(@NotNull Integer draftRev, @NotNull JsonNode draft) {
    }

    public record PublishRequest(String changeSummary) {
    }

    public record DefinitionSummary(
            long id,
            String key,
            String name,
            String category,
            String description,
            String status,
            Integer currentVersion,
            int draftRev,
            Instant updatedAt) {
    }

    public record DefinitionDetail(
            long id,
            String key,
            String name,
            String category,
            String description,
            String status,
            Integer currentVersion,
            int draftRev,
            JsonNode draft,
            Instant createdAt,
            Instant updatedAt) {
    }

    public record VersionSummary(
            long id,
            int version,
            String contentHash,
            String status,
            String changeSummary,
            String publishedBy,
            Instant publishedAt) {
    }

    public record VersionDetail(
            long id,
            int version,
            JsonNode snapshot,
            String contentHash,
            String status,
            String changeSummary,
            String publishedBy,
            Instant publishedAt) {
    }

    public record Position(Double x, Double y) {
    }

    public record VariableDef(String name, String type, Boolean required, JsonNode defaultValue) {
    }

    public record NodeDef(String id, String type, String name, Position position, JsonNode config) {
    }

    public record EdgeDef(
            String id,
            String from,
            String to,
            String condition,
            Boolean defaultEdge,
            Integer order) {
    }

    public record Settings(Integer maxSteps, Integer maxNodeActivations, String timezone) {
    }

    public record FlowDefinition(
            String key,
            String name,
            String tenant,
            Integer version,
            Settings settings,
            List<VariableDef> variables,
            List<NodeDef> nodes,
            List<EdgeDef> edges) {

        public FlowDefinition withVersion(int newVersion) {
            return new FlowDefinition(key, name, tenant, newVersion, settings, variables, nodes, edges);
        }
    }

    public record ValidationIssue(String code, String message, String nodeId, String edgeId) {
    }

    public record ValidationResult(boolean valid, List<ValidationIssue> issues) {
    }
}
