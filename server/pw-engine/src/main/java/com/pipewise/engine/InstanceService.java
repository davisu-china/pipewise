package com.pipewise.engine;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pipewise.engine.EngineDtos.CreateInstanceRequest;
import com.pipewise.engine.EngineDtos.InstanceDetail;
import com.pipewise.engine.EngineDtos.InstanceSummary;
import com.pipewise.engine.EngineRepository.DefinitionVersionRow;
import com.pipewise.engine.EngineRepository.InstanceRow;
import com.pipewise.engine.model.FlowModel.FlowDefinition;
import com.pipewise.engine.model.FlowModel.VariableDef;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.Map;
import java.util.UUID;

@Service
public class InstanceService {

    private final EngineRepository repository;
    private final ObjectMapper objectMapper;
    private final SignService signService;

    public InstanceService(EngineRepository repository, ObjectMapper objectMapper, SignService signService) {
        this.repository = repository;
        this.objectMapper = objectMapper;
        this.signService = signService;
    }

    @Transactional
    public InstanceDetail create(String tenant, CreateInstanceRequest request, String currentUser) {
        DefinitionVersionRow version = repository.findCurrentVersion(tenant, request.key())
                .orElseThrow(() -> new EngineException(
                        404, "NO_PUBLISHED_VERSION", "流程定义未发布或不存在: " + request.key()));

        String instanceId = "inst_" + UUID.randomUUID().toString().replace("-", "");
        String initiator = isBlank(request.initiator()) ? currentUser : request.initiator();
        String title = isBlank(request.title()) ? version.definitionKey() : request.title();

        try {
            repository.insertInstance(
                    instanceId, tenant, version.definitionId(), version.definitionKey(),
                    version.versionId(), version.contentHash(), request.businessKey(),
                    title, initiator);
        } catch (DuplicateKeyException ex) {
            throw EngineException.conflict(
                    "BUSINESS_KEY_DUPLICATED",
                    "同一流程下业务键已存在: " + request.businessKey());
        }

        FlowDefinition flow = objectMapper.convertValue(version.snapshot(), FlowDefinition.class);
        Map<String, Object> variables = request.variables() == null ? Map.of() : request.variables();
        variables.forEach((name, value) ->
                repository.insertVariable(instanceId, name, value, "json"));
        if (flow.variables() != null) {
            for (VariableDef variable : flow.variables()) {
                if (variables.containsKey(variable.name())) {
                    continue;
                }
                if (variable.defaultValue() != null && !variable.defaultValue().isNull()) {
                    Object value = objectMapper.convertValue(variable.defaultValue(), Object.class);
                    repository.insertVariable(instanceId, variable.name(), value, variable.type());
                }
            }
        }

        long tokenId = repository.insertToken(instanceId, "start", null, 1);
        repository.insertJob(instanceId, null, "ACTIVATE_TOKEN", tokenId);

        ObjectNode audit = objectMapper.createObjectNode();
        audit.put("definitionKey", version.definitionKey());
        audit.put("version", version.version());
        audit.put("businessKey", request.businessKey());
        repository.audit(tenant, instanceId, "instance.created", initiator, audit);

        ObjectNode payload = objectMapper.createObjectNode();
        payload.put("instanceId", instanceId);
        payload.put("definitionKey", version.definitionKey());
        payload.put("businessKey", request.businessKey());
        repository.outbox(tenant, instanceId, "instance.created", payload);

        return detail(tenant, instanceId);
    }

    public void withdraw(String tenant, String instanceId, String user) {
        signService.withdraw(tenant, instanceId, user);
    }

    public List<InstanceSummary> list(String tenant, String status, String definitionKey) {
        return repository.listInstances(tenant, status, definitionKey);
    }

    public InstanceDetail detail(String tenant, String instanceId) {
        InstanceRow instance = repository.findInstance(instanceId)
                .orElseThrow(() -> EngineException.notFound("实例不存在: " + instanceId));
        if (!tenant.equals(instance.tenantId())) {
            throw EngineException.notFound("实例不存在: " + instanceId);
        }
        InstanceSummary summary = new InstanceSummary(
                instance.id(),
                instance.definitionKey(),
                instance.businessKey(),
                instance.title(),
                instance.initiator(),
                instance.status(),
                instance.outcome(),
                instance.version(),
                instance.currentNodeIds(),
                instance.createdAt(),
                instance.endedAt());
        return new InstanceDetail(
                summary,
                repository.listOpenNodes(instanceId),
                repository.listInstanceTasks(instanceId),
                repository.listVariables(instanceId),
                repository.timeline(instanceId));
    }

    private boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
