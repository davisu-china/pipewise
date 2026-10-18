package com.pipewise.engine;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pipewise.engine.EngineRepository.DefinitionVersionRow;
import com.pipewise.engine.EngineRepository.InstanceRow;
import com.pipewise.engine.EngineRepository.JobRow;
import com.pipewise.engine.EngineRepository.NodeRow;
import com.pipewise.engine.EngineRepository.TokenRow;
import com.pipewise.engine.model.FlowModel.FlowDefinition;
import com.pipewise.engine.model.FlowModel.NodeDef;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.List;

/**
 * 一个作业 = 一次令牌激活。事务内持有实例 advisory lock，重复投递会被令牌状态挡住。
 */
@Component
public class EngineProcessor {

    private final EngineRepository repository;
    private final TokenAdvancer advancer;
    private final ObjectMapper objectMapper;

    public EngineProcessor(EngineRepository repository,
                           TokenAdvancer advancer,
                           ObjectMapper objectMapper) {
        this.repository = repository;
        this.advancer = advancer;
        this.objectMapper = objectMapper;
    }

    @Transactional
    public void process(JobRow job) {
        if (job.tokenId() <= 0) {
            throw new EngineException(500, "BAD_JOB", "作业缺少 tokenId: " + job.id());
        }

        repository.lockInstanceAdvisory(job.instanceId());
        InstanceRow instance = repository.loadInstanceForUpdate(job.instanceId())
                .orElseThrow(() -> EngineException.notFound("实例不存在: " + job.instanceId()));
        if (isTerminal(instance.status())) {
            return;
        }

        TokenRow token = repository.loadTokenForUpdate(job.tokenId())
                .orElseThrow(() -> EngineException.notFound("令牌不存在: " + job.tokenId()));
        if (!"ACTIVE".equals(token.status())) {
            return;
        }
        if (repository.findNodeInstanceByToken(token.id()).isPresent()) {
            return;
        }

        DefinitionVersionRow version = repository.findVersionById(instance.versionId())
                .orElseThrow(() -> EngineException.notFound("版本不存在: " + instance.versionId()));
        FlowDefinition flow = objectMapper.convertValue(version.snapshot(), FlowDefinition.class);
        NodeDef node = flow.node(token.nodeId());
        if (node == null) {
            throw new EngineException(500, "NODE_MISSING", "快照中找不到节点: " + token.nodeId());
        }

        long nodeInstanceId = repository.insertNodeInstance(
                instance.id(), node.id(), node.type(), token.id());
        repository.bumpStep(instance.id());

        switch (node.type()) {
            case "start" -> {
                repository.completeNodeInstance(nodeInstanceId);
                repository.updateTokenStatus(token.id(), "CONSUMED");
                int advanced = advancer.advance(instance, flow, node, token.id());
                if (advanced == 0) {
                    throw new EngineException(500, "START_NO_OUTGOING", "start 节点没有出边");
                }
                audit(instance, "node.start", "system", node, nodeInstanceId);
            }
            case "end" -> {
                repository.completeNodeInstance(nodeInstanceId);
                repository.updateTokenStatus(token.id(), "CONSUMED");
                audit(instance, "node.end", "system", node, nodeInstanceId);
                if (repository.countOpenTokens(instance.id()) == 0) {
                    repository.completeInstance(instance.id(), "completed");
                    outbox(instance, "instance.completed", null);
                }
            }
            case "approval" -> {
                List<String> assignees = resolveAssignees(node, instance);
                String mode = configText(node, "signMode", "any").toUpperCase();
                if (!List.of("ANY", "ALL", "RACE").contains(mode)) {
                    mode = "ANY";
                }
                String signStyle = configText(node, "signStyle", "parallel").toUpperCase();
                if (!"SERIAL".equals(signStyle)) {
                    signStyle = "PARALLEL";
                }
                String passRule = configText(node, "passRule", "ALL").toUpperCase();
                if (!"RATIO".equals(passRule)) {
                    passRule = "ALL";
                }
                Double ratio = configDouble(node, "passRatio");
                String rejectRule = configText(node, "rejectRule", "VETO_IMMEDIATE").toUpperCase();
                String returnStrategy = configText(node, "rejectStrategy", "terminate");
                String returnTarget = configText(node, "returnTarget", null);

                long sessionId = repository.insertSignSession(
                        instance.id(), nodeInstanceId, node.id(), mode, signStyle,
                        passRule, ratio, rejectRule, returnStrategy, returnTarget, assignees.size());
                String title = taskTitle(instance, node);
                for (int index = 0; index < assignees.size(); index++) {
                    String assignee = assignees.get(index);
                    String status = "SERIAL".equals(signStyle) && index > 0 ? "PENDING" : "CREATED";
                    long taskId = repository.insertTask(
                            instance.tenantId(), instance.id(), nodeInstanceId, node.id(),
                            sessionId, assignee, title, status);
                    ObjectNode payload = objectMapper.createObjectNode();
                    payload.put("taskId", taskId);
                    payload.put("nodeId", node.id());
                    payload.put("assignee", assignee);
                    payload.put("signSessionId", sessionId);
                    repository.outbox(instance.tenantId(), instance.id(), "task.created", payload);
                }
                repository.markNodeWaiting(nodeInstanceId);
                repository.updateTokenStatus(token.id(), "WAITING");
                ObjectNode detail = objectMapper.createObjectNode();
                detail.put("nodeId", node.id());
                detail.put("nodeInstanceId", nodeInstanceId);
                detail.put("signSessionId", sessionId);
                detail.put("mode", mode);
                detail.put("expected", assignees.size());
                detail.put("assignees", String.join(",", assignees));
                repository.audit(instance.tenantId(), instance.id(), "sign.session.created", "system", detail);
            }
            default -> throw new EngineException(
                    501, "NODE_NOT_SUPPORTED",
                    "P2 暂不支持节点类型: " + node.type() + "（" + node.id() + "）");
        }
    }

    private List<String> resolveAssignees(NodeDef node, InstanceRow instance) {
        List<String> values = new ArrayList<>();
        if (node.config() != null) {
            var assignees = node.config().get("assignees");
            if (assignees != null && !assignees.isNull()) {
                if (assignees.isArray()) {
                    assignees.forEach(item -> values.add(item.asText()));
                } else {
                    values.addAll(splitAssignees(assignees.asText()));
                }
            }
            if (values.isEmpty() && node.config().hasNonNull("assignee")) {
                values.addAll(splitAssignees(node.config().get("assignee").asText()));
            }
        }

        List<String> resolved = new ArrayList<>();
        for (String value : values) {
            String candidate = value == null ? "" : value.trim();
            if (candidate.isEmpty()) {
                continue;
            }
            if ("initiator".equals(candidate)) {
                candidate = instance.initiator();
            } else if (candidate.startsWith("user:")) {
                candidate = candidate.substring(5);
            }
            if (!candidate.isBlank() && !resolved.contains(candidate)) {
                resolved.add(candidate);
            }
        }
        if (resolved.isEmpty()) {
            resolved.add(instance.initiator());
        }
        return resolved;
    }

    private List<String> splitAssignees(String value) {
        List<String> result = new ArrayList<>();
        if (value == null) {
            return result;
        }
        for (String part : value.split(",")) {
            if (!part.isBlank()) {
                result.add(part.trim());
            }
        }
        return result;
    }

    private String configText(NodeDef node, String field, String fallback) {
        if (node.config() != null && node.config().hasNonNull(field)) {
            String value = node.config().get(field).asText();
            if (!value.isBlank()) {
                return value;
            }
        }
        return fallback;
    }

    private Double configDouble(NodeDef node, String field) {
        if (node.config() != null && node.config().hasNonNull(field)) {
            var value = node.config().get(field);
            if (value.isNumber()) {
                return value.asDouble();
            }
            try {
                return Double.parseDouble(value.asText());
            } catch (NumberFormatException ignored) {
                return null;
            }
        }
        return null;
    }

    private String taskTitle(InstanceRow instance, NodeDef node) {
        String base = instance.title() == null || instance.title().isBlank()
                ? instance.definitionKey() : instance.title();
        return base + " · " + (node.name() == null || node.name().isBlank() ? node.id() : node.name());
    }

    private void audit(InstanceRow instance, String action, String actor, NodeDef node, long nodeInstanceId) {
        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("nodeId", node.id());
        detail.put("nodeType", node.type());
        detail.put("nodeInstanceId", nodeInstanceId);
        repository.audit(instance.tenantId(), instance.id(), action, actor, detail);
    }

    private void outbox(InstanceRow instance, String eventType, Object payload) {
        ObjectNode body = objectMapper.createObjectNode();
        body.put("instanceId", instance.id());
        body.put("status", "COMPLETED");
        repository.outbox(instance.tenantId(), instance.id(), eventType, body);
    }

    private boolean isTerminal(String status) {
        return "COMPLETED".equals(status) || "TERMINATED".equals(status) || "FAILED".equals(status);
    }
}
