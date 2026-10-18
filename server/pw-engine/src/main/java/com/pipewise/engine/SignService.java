package com.pipewise.engine;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pipewise.engine.EngineDtos.TaskView;
import com.pipewise.engine.EngineRepository.DefinitionVersionRow;
import com.pipewise.engine.EngineRepository.InstanceRow;
import com.pipewise.engine.EngineRepository.NodeRow;
import com.pipewise.engine.EngineRepository.SignSessionRow;
import com.pipewise.engine.EngineRepository.TaskRow;
import com.pipewise.engine.EngineRepository.TokenRow;
import com.pipewise.engine.SignDecisionEngine.Outcome;
import com.pipewise.engine.SignDecisionEngine.SessionState;
import com.pipewise.engine.model.FlowModel.FlowDefinition;
import com.pipewise.engine.model.FlowModel.NodeDef;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
public class SignService {

    private final EngineRepository repository;
    private final TokenAdvancer advancer;
    private final ObjectMapper objectMapper;

    public SignService(EngineRepository repository, TokenAdvancer advancer, ObjectMapper objectMapper) {
        this.repository = repository;
        this.advancer = advancer;
        this.objectMapper = objectMapper;
    }

    /**
     * 由 TaskService 在已持有实例锁、任务行锁的前提下调用。
     */
    public TaskView complete(String tenant, TaskRow task, String user, String verdict, String comment) {
        SignSessionRow session = repository.findSignSessionForUpdate(task.signSessionId())
                .orElseThrow(() -> EngineException.notFound("签核会话不存在: " + task.signSessionId()));
        if (!"OPEN".equals(session.status())) {
            throw EngineException.conflict("SESSION_CLOSED", "签核会话已结束");
        }

        int updated = repository.completeTask(task.id(), verdict, comment);
        if (updated == 0) {
            return repository.findTaskView(task.id())
                    .orElseThrow(() -> EngineException.notFound("任务不存在: " + task.id()));
        }
        repository.updateSessionCounts(session.id(), verdict);

        if ("return".equals(verdict)) {
            repository.decideSession(session.id(), "RETURN");
            repository.cancelSessionTasks(session.id());
            NodeRow node = completeNodeAndConsumeToken(task);
            InstanceRow instance = repository.loadInstanceForUpdate(task.instanceId())
                    .orElseThrow(() -> EngineException.notFound("实例不存在: " + task.instanceId()));
            applyReturnStrategy(instance, session, user, "return");
            audit(tenant, instance, "task.returned", user, task, "return");
            return repository.findTaskView(task.id())
                    .orElseThrow(() -> EngineException.notFound("任务不存在: " + task.id()));
        }

        int completed = session.completed() + 1;
        int approve = session.approve() + ("approve".equals(verdict) ? 1 : 0);
        int reject = session.reject() + ("reject".equals(verdict) ? 1 : 0);
        Outcome outcome = SignDecisionEngine.evaluate(new SessionState(
                session.mode(),
                session.passRuleType(),
                session.ratio(),
                session.rejectRule(),
                session.expected(),
                completed,
                approve,
                reject), verdict);

        if (outcome == Outcome.WAIT) {
            if ("ALL".equals(session.mode())
                    && "SERIAL".equals(session.signStyle())
                    && "approve".equals(verdict)) {
                repository.activateNextPendingTask(session.id());
            }
            InstanceRow instance = repository.findInstance(task.instanceId())
                    .orElseThrow(() -> EngineException.notFound("实例不存在: " + task.instanceId()));
            audit(tenant, instance, "task.approved".equals(verdict) ? "task.approved" : "task.rejected",
                    user, task, verdict);
            outboxTaskCompleted(instance, task, verdict);
            return repository.findTaskView(task.id())
                    .orElseThrow(() -> EngineException.notFound("任务不存在: " + task.id()));
        }

        repository.cancelSessionTasks(session.id());
        repository.decideSession(session.id(), outcome.name());
        NodeRow node = completeNodeAndConsumeToken(task);
        InstanceRow instance = repository.loadInstanceForUpdate(task.instanceId())
                .orElseThrow(() -> EngineException.notFound("实例不存在: " + task.instanceId()));

        if (outcome == Outcome.APPROVE) {
            advance(instance, task, node);
            audit(tenant, instance, "sign.approved", user, task, "approve");
            outboxDecision(instance, task, session, "APPROVE");
        } else {
            applyReturnStrategy(instance, session, user, "reject");
            audit(tenant, instance, "sign.rejected", user, task, "reject");
            outboxDecision(instance, task, session, "REJECT");
        }
        outboxTaskCompleted(instance, task, verdict);
        return repository.findTaskView(task.id())
                .orElseThrow(() -> EngineException.notFound("任务不存在: " + task.id()));
    }

    @Transactional
    public TaskView addSign(String tenant, long taskId, String user, String assignee) {
        TaskRow preview = repository.findTask(taskId)
                .orElseThrow(() -> EngineException.notFound("任务不存在: " + taskId));
        repository.lockInstanceAdvisory(preview.instanceId());
        TaskRow task = repository.findTaskForUpdate(taskId)
                .orElseThrow(() -> EngineException.notFound("任务不存在: " + taskId));
        if (task.signSessionId() == null) {
            throw EngineException.badRequest("NO_SIGN_SESSION", "该任务不在签核会话中");
        }
        if (!task.assignee().equals(user)) {
            throw EngineException.forbidden("NOT_ASSIGNEE", "当前用户不是该任务的处理人");
        }
        SignSessionRow session = repository.findSignSessionForUpdate(task.signSessionId())
                .orElseThrow(() -> EngineException.notFound("签核会话不存在"));
        if (!"OPEN".equals(session.status())) {
            throw EngineException.conflict("SESSION_CLOSED", "签核会话已结束");
        }
        repository.incrementSessionExpected(session.id());
        String status = "SERIAL".equals(session.signStyle()) ? "PENDING" : "CREATED";
        long newTaskId = repository.insertTask(
                tenant, task.instanceId(), task.nodeInstanceId(), task.nodeId(),
                session.id(), assignee, task.title(), status);
        repository.audit(tenant, task.instanceId(), "sign.added", user, detail("taskId", taskId, "assignee", assignee));
        return repository.findTaskView(newTaskId)
                .orElseThrow(() -> EngineException.notFound("任务不存在: " + newTaskId));
    }

    @Transactional
    public TaskView transfer(String tenant, long taskId, String user, String assignee) {
        TaskRow preview = repository.findTask(taskId)
                .orElseThrow(() -> EngineException.notFound("任务不存在: " + taskId));
        repository.lockInstanceAdvisory(preview.instanceId());
        TaskRow task = repository.findTaskForUpdate(taskId)
                .orElseThrow(() -> EngineException.notFound("任务不存在: " + taskId));
        if (!"CREATED".equals(task.status())) {
            throw EngineException.conflict("TASK_ALREADY_FINISHED", "只有待处理任务可以转交");
        }
        if (!task.assignee().equals(user)) {
            throw EngineException.forbidden("NOT_ASSIGNEE", "当前用户不是该任务的处理人");
        }
        repository.delegateTask(task.id());
        long newTaskId = repository.insertTask(
                tenant, task.instanceId(), task.nodeInstanceId(), task.nodeId(),
                task.signSessionId(), assignee, task.title(), "CREATED");
        repository.audit(tenant, task.instanceId(), "task.transferred", user,
                detail("from", user, "to", assignee));
        return repository.findTaskView(newTaskId)
                .orElseThrow(() -> EngineException.notFound("任务不存在: " + newTaskId));
    }

    @Transactional
    public void withdraw(String tenant, String instanceId, String user) {
        repository.lockInstanceAdvisory(instanceId);
        InstanceRow instance = repository.loadInstanceForUpdate(instanceId)
                .orElseThrow(() -> EngineException.notFound("实例不存在: " + instanceId));
        if (!tenant.equals(instance.tenantId())) {
            throw EngineException.notFound("实例不存在: " + instanceId);
        }
        if (!"RUNNING".equals(instance.status())) {
            throw EngineException.conflict("INSTANCE_NOT_RUNNING", "只有运行中的实例可以撤回");
        }
        repository.cancelOpenSessions(instanceId);
        repository.cancelOpenTokens(instanceId);
        repository.cancelTasks(instanceId);
        repository.terminateInstance(instanceId, "withdrawn");
        repository.audit(tenant, instanceId, "instance.withdrawn", user, objectMapper.createObjectNode());
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("instanceId", instanceId);
        payload.put("outcome", "withdrawn");
        repository.outbox(tenant, instanceId, "instance.terminated", payload);
    }

    private NodeRow completeNodeAndConsumeToken(TaskRow task) {
        NodeRow node = repository.loadNodeInstance(task.nodeInstanceId())
                .orElseThrow(() -> EngineException.notFound("节点实例不存在: " + task.nodeInstanceId()));
        repository.completeNodeInstance(node.id());
        TokenRow token = node.tokenId() == null ? null
                : repository.loadTokenForUpdate(node.tokenId()).orElse(null);
        if (token != null) {
            repository.updateTokenStatus(token.id(), "CONSUMED");
        }
        return node;
    }

    private void advance(InstanceRow instance, TaskRow task, NodeRow node) {
        DefinitionVersionRow version = repository.findVersionById(instance.versionId())
                .orElseThrow(() -> EngineException.notFound("版本不存在: " + instance.versionId()));
        FlowDefinition flow = objectMapper.convertValue(version.snapshot(), FlowDefinition.class);
        NodeDef nodeDef = flow.node(task.nodeId());
        if (nodeDef == null) {
            throw new EngineException(500, "NODE_MISSING", "快照中找不到节点: " + task.nodeId());
        }
        long parentTokenId = node.tokenId() == null ? 0L : node.tokenId();
        int advanced = advancer.advance(instance, flow, nodeDef, parentTokenId);
        if (advanced == 0) {
            repository.completeInstance(instance.id(), "completed");
            ObjectNode payload = objectMapper.createObjectNode();
            payload.put("instanceId", instance.id());
            payload.put("outcome", "completed");
            repository.outbox(instance.tenantId(), instance.id(), "instance.completed", payload);
        }
    }

    private void applyReturnStrategy(InstanceRow instance, SignSessionRow session, String actor, String reason) {
        String strategy = session.returnStrategy() == null || session.returnStrategy().isBlank()
                ? "terminate" : session.returnStrategy();
        if ("terminate".equals(strategy)) {
            repository.cancelOpenSessions(instance.id());
            repository.cancelOpenTokens(instance.id());
            repository.cancelTasks(instance.id());
            repository.completeInstance(instance.id(), "rejected");
            ObjectNode payload = objectMapper.createObjectNode();
            payload.put("instanceId", instance.id());
            payload.put("outcome", "rejected");
            repository.outbox(instance.tenantId(), instance.id(), "instance.completed", payload);
            return;
        }

        String target = "to_start".equals(strategy)
                ? "start"
                : (session.returnTarget() == null || session.returnTarget().isBlank()
                ? "start" : session.returnTarget());
        repository.cancelOpenSessions(instance.id());
        repository.cancelOpenTokens(instance.id());
        repository.cancelTasks(instance.id());
        int round = repository.incrementRound(instance.id());
        long tokenId = repository.insertToken(instance.id(), target, null, round);
        repository.insertJob(instance.id(), null, "ACTIVATE_TOKEN", tokenId);

        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("target", target);
        detail.put("round", round);
        detail.put("reason", reason);
        repository.audit(instance.tenantId(), instance.id(), "instance.returned", actor, detail);
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("instanceId", instance.id());
        payload.put("target", target);
        payload.put("round", round);
        repository.outbox(instance.tenantId(), instance.id(), "instance.returned", payload);
    }

    private void audit(String tenant, InstanceRow instance, String action, String actor, TaskRow task, String verdict) {
        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("taskId", task.id());
        detail.put("nodeId", task.nodeId());
        detail.put("signSessionId", task.signSessionId());
        detail.put("verdict", verdict);
        repository.audit(tenant, instance.id(), action, actor, detail);
    }

    private void outboxDecision(InstanceRow instance, TaskRow task, SignSessionRow session, String decision) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("instanceId", instance.id());
        payload.put("taskId", task.id());
        payload.put("signSessionId", session.id());
        payload.put("decision", decision);
        repository.outbox(instance.tenantId(), instance.id(), "sign.decided", payload);
    }

    private void outboxTaskCompleted(InstanceRow instance, TaskRow task, String verdict) {
        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("instanceId", instance.id());
        payload.put("taskId", task.id());
        payload.put("verdict", verdict);
        repository.outbox(instance.tenantId(), instance.id(), "task.completed", payload);
    }

    private ObjectNode detail(String key1, Object value1, String key2, Object value2) {
        ObjectNode detail = objectMapper.createObjectNode();
        detail.put(key1, String.valueOf(value1));
        detail.put(key2, String.valueOf(value2));
        return detail;
    }
}
