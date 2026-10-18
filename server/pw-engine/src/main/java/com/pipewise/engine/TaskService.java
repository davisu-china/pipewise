package com.pipewise.engine;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pipewise.engine.EngineDtos.CompleteTaskRequest;
import com.pipewise.engine.EngineDtos.TaskView;
import com.pipewise.engine.EngineRepository.DefinitionVersionRow;
import com.pipewise.engine.EngineRepository.InstanceRow;
import com.pipewise.engine.EngineRepository.NodeRow;
import com.pipewise.engine.EngineRepository.TaskRow;
import com.pipewise.engine.EngineRepository.TokenRow;
import com.pipewise.engine.model.FlowModel.FlowDefinition;
import com.pipewise.engine.model.FlowModel.NodeDef;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
public class TaskService {

    private final EngineRepository repository;
    private final TokenAdvancer advancer;
    private final ObjectMapper objectMapper;
    private final SignService signService;

    public TaskService(EngineRepository repository,
                       TokenAdvancer advancer,
                       ObjectMapper objectMapper,
                       SignService signService) {
        this.repository = repository;
        this.advancer = advancer;
        this.objectMapper = objectMapper;
        this.signService = signService;
    }

    public List<TaskView> list(String assignee, String status) {
        return repository.listTasks(assignee, status);
    }

    public TaskView get(long id) {
        return repository.findTaskView(id)
                .orElseThrow(() -> EngineException.notFound("任务不存在: " + id));
    }

    public TaskView addSign(String tenant, long taskId, String user, String assignee) {
        return signService.addSign(tenant, taskId, user, assignee);
    }

    public TaskView transfer(String tenant, long taskId, String user, String assignee) {
        return signService.transfer(tenant, taskId, user, assignee);
    }

    @Transactional
    public TaskView complete(String tenant, long taskId, String user, CompleteTaskRequest request) {
        TaskRow preview = repository.findTask(taskId)
                .orElseThrow(() -> EngineException.notFound("任务不存在: " + taskId));
        repository.lockInstanceAdvisory(preview.instanceId());

        TaskRow task = repository.findTaskForUpdate(taskId)
                .orElseThrow(() -> EngineException.notFound("任务不存在: " + taskId));
        if ("COMPLETED".equals(task.status())) {
            return repository.findTaskView(taskId)
                    .orElseThrow(() -> EngineException.notFound("任务不存在: " + taskId));
        }
        if (!"CREATED".equals(task.status())) {
            throw EngineException.conflict("TASK_ALREADY_FINISHED", "任务已被取消或已结束: " + taskId);
        }
        if (!task.assignee().equals(user)) {
            throw EngineException.forbidden("NOT_ASSIGNEE", "当前用户不是该任务的处理人");
        }
        if (task.signSessionId() != null) {
            return signService.complete(tenant, task, user, request.verdict(), request.comment());
        }

        int updated = repository.completeTask(taskId, request.verdict(), request.comment());
        if (updated == 0) {
            return repository.findTaskView(taskId)
                    .orElseThrow(() -> EngineException.notFound("任务不存在: " + taskId));
        }

        NodeRow node = repository.loadNodeInstance(task.nodeInstanceId())
                .orElseThrow(() -> EngineException.notFound("节点实例不存在: " + task.nodeInstanceId()));
        repository.completeNodeInstance(node.id());

        TokenRow token = node.tokenId() == null ? null
                : repository.loadTokenForUpdate(node.tokenId()).orElse(null);
        if (token != null) {
            repository.updateTokenStatus(token.id(), "CONSUMED");
        }

        InstanceRow instance = repository.loadInstanceForUpdate(task.instanceId())
                .orElseThrow(() -> EngineException.notFound("实例不存在: " + task.instanceId()));
        if (!tenant.equals(instance.tenantId())) {
            throw EngineException.notFound("实例不存在: " + task.instanceId());
        }

        ObjectNode audit = objectMapper.createObjectNode();
        audit.put("taskId", taskId);
        audit.put("nodeId", task.nodeId());
        audit.put("verdict", request.verdict());
        audit.put("comment", request.comment());

        if ("reject".equals(request.verdict())) {
            repository.cancelOpenTokens(instance.id());
            repository.cancelTasks(instance.id());
            repository.completeInstance(instance.id(), "rejected");
            repository.audit(tenant, instance.id(), "task.rejected", user, audit);
            outboxCompleted(instance, "rejected", taskId);
        } else {
            DefinitionVersionRow version = repository.findVersionById(instance.versionId())
                    .orElseThrow(() -> EngineException.notFound("版本不存在: " + instance.versionId()));
            FlowDefinition flow = objectMapper.convertValue(version.snapshot(), FlowDefinition.class);
            NodeDef nodeDef = flow.node(task.nodeId());
            if (nodeDef == null) {
                throw new EngineException(500, "NODE_MISSING", "快照中找不到节点: " + task.nodeId());
            }
            int advanced = advancer.advance(instance, flow, nodeDef, token == null ? 0L : token.id());
            repository.audit(tenant, instance.id(), "task.approved", user, audit);
            if (advanced == 0) {
                repository.completeInstance(instance.id(), "completed");
                outboxCompleted(instance, "completed", taskId);
            }
        }

        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("taskId", taskId);
        payload.put("verdict", request.verdict());
        payload.put("nodeId", task.nodeId());
        repository.outbox(tenant, instance.id(), "task.completed", payload);

        return repository.findTaskView(taskId)
                .orElseThrow(() -> EngineException.notFound("任务不存在: " + taskId));
    }

    private void outboxCompleted(InstanceRow instance, String outcome, long taskId) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("instanceId", instance.id());
        payload.put("outcome", outcome);
        payload.put("taskId", taskId);
        repository.outbox(instance.tenantId(), instance.id(), "instance.completed", payload);
    }
}
