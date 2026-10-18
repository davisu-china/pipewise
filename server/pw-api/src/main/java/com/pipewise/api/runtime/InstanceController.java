package com.pipewise.api.runtime;

import com.pipewise.api.web.TraceIdFilter;
import com.pipewise.common.api.ApiResponse;
import com.pipewise.engine.EngineDtos.CreateInstanceRequest;
import com.pipewise.engine.EngineDtos.InstanceDetail;
import com.pipewise.engine.EngineDtos.InstanceSummary;
import com.pipewise.engine.InstanceService;
import jakarta.validation.Valid;
import org.slf4j.MDC;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/v1/instances")
public class InstanceController {

    private final InstanceService service;

    public InstanceController(InstanceService service) {
        this.service = service;
    }

    @PostMapping
    public ApiResponse<InstanceDetail> create(
            @Valid @RequestBody CreateInstanceRequest request,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant,
            @RequestHeader(value = "X-User-Id", defaultValue = "anonymous") String user) {
        return ApiResponse.ok(service.create(tenant, request, user), traceId());
    }

    @GetMapping
    public ApiResponse<List<InstanceSummary>> list(
            @RequestParam(required = false) String status,
            @RequestParam(value = "key", required = false) String definitionKey,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant) {
        return ApiResponse.ok(service.list(tenant, status, definitionKey), traceId());
    }

    @GetMapping("/{id}")
    public ApiResponse<InstanceDetail> detail(
            @PathVariable String id,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant) {
        return ApiResponse.ok(service.detail(tenant, id), traceId());
    }

    private String traceId() {
        return MDC.get(TraceIdFilter.TRACE_ID);
    }
}
