package com.pipewise.api.definition;

import com.fasterxml.jackson.core.JsonProcessingException;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.fasterxml.jackson.databind.node.ObjectNode;
import com.pipewise.api.definition.DefinitionDtos.DefinitionDetail;
import com.pipewise.api.definition.DefinitionDtos.DefinitionSummary;
import com.pipewise.engine.model.FlowModel.FlowDefinition;
import com.pipewise.api.definition.DefinitionDtos.PublishRequest;
import com.pipewise.api.definition.DefinitionDtos.SaveDraftRequest;
import com.pipewise.api.definition.DefinitionDtos.ValidationIssue;
import com.pipewise.api.definition.DefinitionDtos.ValidationResult;
import com.pipewise.api.definition.DefinitionDtos.VersionDetail;
import com.pipewise.api.definition.DefinitionDtos.VersionSummary;
import com.pipewise.api.web.ApiException;
import org.springframework.dao.DuplicateKeyException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.List;
import java.util.stream.Collectors;

@Service
public class DefinitionService {

    private final DefinitionRepository repository;
    private final DefinitionValidator validator;
    private final ObjectMapper objectMapper;

    public DefinitionService(DefinitionRepository repository,
                             DefinitionValidator validator,
                             ObjectMapper objectMapper) {
        this.repository = repository;
        this.validator = validator;
        this.objectMapper = objectMapper;
    }

    public List<DefinitionSummary> list(String tenant, String keyword) {
        return repository.list(tenant, keyword);
    }

    public DefinitionDetail get(String tenant, String key) {
        return repository.find(tenant, key)
                .orElseThrow(() -> ApiException.notFound("流程定义不存在: " + key));
    }

    public DefinitionDetail create(String tenant, DefinitionDtos.CreateRequest request, String actor) {
        try {
            return repository.create(tenant, request, actor);
        } catch (DuplicateKeyException ex) {
            throw ApiException.conflict("DEFINITION_EXISTS", "流程定义 key 已存在: " + request.key());
        }
    }

    public DefinitionDetail saveDraft(String tenant, String key, SaveDraftRequest request) {
        get(tenant, key);
        int updated = repository.saveDraft(tenant, key, request.draftRev(), request.draft());
        if (updated == 0) {
            throw ApiException.conflict("DRAFT_CONFLICT",
                    "草稿已被他人修改，请刷新后重试（draftRev=" + request.draftRev() + "）");
        }
        return get(tenant, key);
    }

    public ValidationResult validateDraft(String tenant, String key, JsonNode draft) {
        get(tenant, key);
        FlowDefinition flow = toFlow(draft);
        return validator.validate(flow);
    }

    @Transactional
    public VersionSummary publish(String tenant, String key, PublishRequest request, String actor) {
        DefinitionRepository.LockedDefinition locked = repository.findForUpdate(tenant, key)
                .orElseThrow(() -> ApiException.notFound("流程定义不存在: " + key));

        FlowDefinition draft = toFlow(locked.draft());
        ValidationResult validation = validator.validate(draft);
        if (!validation.valid()) {
            throw ApiException.badRequest("VALIDATION_FAILED", joinIssues(validation.issues()));
        }

        int nextVersion = repository.nextVersion(locked.id());
        String name = isBlank(draft.name()) ? locked.name() : draft.name();
        FlowDefinition snapshot = new FlowDefinition(
                locked.key(),
                name,
                tenant,
                nextVersion,
                draft.settings(),
                draft.variables() == null ? List.of() : draft.variables(),
                draft.nodes() == null ? List.of() : draft.nodes(),
                draft.edges() == null ? List.of() : draft.edges());

        String contentHash = sha256(toJson(snapshot));
        JsonNode variables = objectMapper.valueToTree(snapshot.variables());
        String summary = request == null ? null : request.changeSummary();

        VersionSummary published = repository.insertVersion(
                locked.id(), nextVersion, toJsonNode(snapshot), contentHash, variables, actor, summary);
        repository.updateCurrentVersion(locked.id(), published.id());

        ObjectNode auditDetail = objectMapper.createObjectNode();
        auditDetail.put("version", nextVersion);
        auditDetail.put("contentHash", contentHash);
        repository.audit(tenant, "definition.publish", actor, auditDetail);
        return published;
    }

    public List<VersionSummary> versions(String tenant, String key) {
        long definitionId = definitionId(tenant, key);
        return repository.listVersions(definitionId);
    }

    public VersionDetail version(String tenant, String key, int version) {
        long definitionId = definitionId(tenant, key);
        return repository.findVersion(definitionId, version)
                .orElseThrow(() -> ApiException.notFound("版本不存在: v" + version));
    }

    @Transactional
    public void setDefault(String tenant, String key, int version, String actor) {
        long definitionId = definitionId(tenant, key);
        long versionId = repository.findVersionId(definitionId, version)
                .orElseThrow(() -> ApiException.notFound("版本不存在: v" + version));
        repository.updateCurrentVersion(definitionId, versionId);
        ObjectNode detail = objectMapper.createObjectNode();
        detail.put("defaultVersion", version);
        repository.audit(tenant, "definition.setDefault", actor, detail);
    }

    private long definitionId(String tenant, String key) {
        return repository.findDefinitionId(tenant, key)
                .orElseThrow(() -> ApiException.notFound("流程定义不存在: " + key));
    }

    private FlowDefinition toFlow(JsonNode draft) {
        try {
            return objectMapper.convertValue(draft, FlowDefinition.class);
        } catch (IllegalArgumentException ex) {
            throw ApiException.badRequest("INVALID_DRAFT", "草稿结构不合法: " + ex.getMessage());
        }
    }

    private JsonNode toJsonNode(Object value) {
        return objectMapper.valueToTree(value);
    }

    private String toJson(Object value) {
        try {
            return objectMapper.writeValueAsString(value);
        } catch (JsonProcessingException ex) {
            throw new IllegalStateException("cannot serialize snapshot", ex);
        }
    }

    private String sha256(String value) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] bytes = digest.digest(value.getBytes(StandardCharsets.UTF_8));
            StringBuilder result = new StringBuilder(bytes.length * 2);
            for (byte b : bytes) {
                result.append(String.format("%02x", b));
            }
            return result.toString();
        } catch (NoSuchAlgorithmException ex) {
            throw new IllegalStateException("SHA-256 not available", ex);
        }
    }

    private String joinIssues(List<ValidationIssue> issues) {
        return issues.stream()
                .map(issue -> {
                    String prefix = issue.nodeId() != null ? "[" + issue.nodeId() + "] "
                            : issue.edgeId() != null ? "[" + issue.edgeId() + "] " : "";
                    return prefix + issue.message();
                })
                .collect(Collectors.joining("; "));
    }

    private boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
