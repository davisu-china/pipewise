package com.pipewise.engine;

import com.fasterxml.jackson.databind.JsonNode;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;

import java.time.Instant;
import java.util.List;
import java.util.Map;

public final class EngineDtos {

    private EngineDtos() {
    }

    public record CreateInstanceRequest(
            @NotBlank String key,
            @NotBlank String businessKey,
            String title,
            String initiator,
            Map<String, Object> variables) {
    }

    public record CompleteTaskRequest(
            @NotBlank
            @Pattern(regexp = "approve|reject|return", message = "verdict 只能是 approve、reject 或 return")
            String verdict,
            String comment) {
    }

    public record AssigneeRequest(@NotBlank String assignee) {
    }

    public record InstanceSummary(
            String id,
            String definitionKey,
            String businessKey,
            String title,
            String initiator,
            String status,
            String outcome,
            int version,
            List<String> currentNodeIds,
            Instant createdAt,
            Instant endedAt) {
    }

    public record NodeState(
            long id,
            String nodeId,
            String nodeType,
            String status,
            Long tokenId,
            Instant startedAt,
            Instant endedAt) {
    }

    public record TaskView(
            long id,
            String instanceId,
            String nodeId,
            String assignee,
            String status,
            String verdict,
            String comment,
            String title,
            Instant createdAt,
            Instant completedAt) {
    }

    public record TimelineItem(
            String action,
            String actor,
            JsonNode detail,
            Instant createdAt) {
    }

    public record InstanceDetail(
            InstanceSummary summary,
            List<NodeState> nodes,
            List<TaskView> tasks,
            Map<String, Object> variables,
            List<TimelineItem> timeline) {
    }
}
