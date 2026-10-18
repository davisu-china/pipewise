package com.pipewise.api.definition;

import com.fasterxml.jackson.databind.JsonNode;
import com.pipewise.api.definition.DefinitionDtos.CreateRequest;
import com.pipewise.api.definition.DefinitionDtos.DefinitionDetail;
import com.pipewise.api.definition.DefinitionDtos.DefinitionSummary;
import com.pipewise.api.definition.DefinitionDtos.PublishRequest;
import com.pipewise.api.definition.DefinitionDtos.SaveDraftRequest;
import com.pipewise.api.definition.DefinitionDtos.ValidationResult;
import com.pipewise.api.definition.DefinitionDtos.VersionDetail;
import com.pipewise.api.definition.DefinitionDtos.VersionSummary;
import com.pipewise.api.web.TraceIdFilter;
import com.pipewise.common.api.ApiResponse;
import jakarta.validation.Valid;
import org.slf4j.MDC;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/definitions")
public class DefinitionController {

    private final DefinitionService service;

    public DefinitionController(DefinitionService service) {
        this.service = service;
    }

    @GetMapping
    public ApiResponse<List<DefinitionSummary>> list(
            @RequestParam(required = false) String keyword,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant) {
        return ApiResponse.ok(service.list(tenant, keyword), traceId());
    }

    @PostMapping
    public ApiResponse<DefinitionDetail> create(
            @Valid @RequestBody CreateRequest request,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant,
            @RequestHeader(value = "X-User-Id", defaultValue = "anonymous") String actor) {
        return ApiResponse.ok(service.create(tenant, request, actor), traceId());
    }

    @GetMapping("/{key}")
    public ApiResponse<DefinitionDetail> get(
            @PathVariable String key,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant) {
        return ApiResponse.ok(service.get(tenant, key), traceId());
    }

    @PutMapping("/{key}/draft")
    public ApiResponse<DefinitionDetail> saveDraft(
            @PathVariable String key,
            @Valid @RequestBody SaveDraftRequest request,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant) {
        return ApiResponse.ok(service.saveDraft(tenant, key, request), traceId());
    }

    @PostMapping("/{key}/validate")
    public ApiResponse<ValidationResult> validate(
            @PathVariable String key,
            @RequestBody JsonNode draft,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant) {
        return ApiResponse.ok(service.validateDraft(tenant, key, draft), traceId());
    }

    @PostMapping("/{key}/publish")
    public ApiResponse<VersionSummary> publish(
            @PathVariable String key,
            @RequestBody(required = false) PublishRequest request,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant,
            @RequestHeader(value = "X-User-Id", defaultValue = "anonymous") String actor) {
        return ApiResponse.ok(service.publish(tenant, key, request, actor), traceId());
    }

    @GetMapping("/{key}/versions")
    public ApiResponse<List<VersionSummary>> versions(
            @PathVariable String key,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant) {
        return ApiResponse.ok(service.versions(tenant, key), traceId());
    }

    @GetMapping("/{key}/versions/{version}")
    public ApiResponse<VersionDetail> version(
            @PathVariable String key,
            @PathVariable int version,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant) {
        return ApiResponse.ok(service.version(tenant, key, version), traceId());
    }

    @PostMapping("/{key}/versions/{version}/default")
    public ApiResponse<Map<String, Object>> setDefault(
            @PathVariable String key,
            @PathVariable int version,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant,
            @RequestHeader(value = "X-User-Id", defaultValue = "anonymous") String actor) {
        service.setDefault(tenant, key, version, actor);
        return ApiResponse.ok(Map.of("defaultVersion", version), traceId());
    }

    private String traceId() {
        return MDC.get(TraceIdFilter.TRACE_ID);
    }
}
