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
                String assignee = assignee(node, instance);
                String title = taskTitle(instance, node);
                long taskId = repository.insertTask(
                        instance.tenantId(), instance.id(), nodeInstanceId, node.id(), assignee, title);
                repository.markNodeWaiting(nodeInstanceId);
                repository.updateTokenStatus(token.id(), "WAITING");
                audit(instance, "task.created", "system", node, nodeInstanceId);
                ObjectNode payload = objectMapper.createObjectNode();
                payload.put("taskId", taskId);
                payload.put("nodeId", node.id());
                payload.put("assignee", assignee);
                repository.outbox(instance.tenantId(), instance.id(), "task.created", payload);
            }
            default -> throw new EngineException(
                    501, "NODE_NOT_SUPPORTED",
                    "P2 暂不支持节点类型: " + node.type() + "（" + node.id() + "）");
        }
    }

    private String assignee(NodeDef node, InstanceRow instance) {
        if (node.config() != null && node.config().hasNonNull("assignee")) {
            String value = node.config().get("assignee").asText();
            if (!value.isBlank() && !"initiator".equals(value)) {
                return value.startsWith("user:") ? value.substring(5) : value;
            }
        }
        return instance.initiator();
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
