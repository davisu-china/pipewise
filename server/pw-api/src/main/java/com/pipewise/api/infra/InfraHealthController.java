package com.pipewise.api.infra;

import com.pipewise.api.web.TraceIdFilter;
import com.pipewise.common.api.ApiResponse;
import org.slf4j.MDC;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Instant;
import java.util.LinkedHashMap;
import java.util.Map;

@RestController
@RequestMapping("/api/v1")
public class InfraHealthController {

    private final InfraHealthService healthService;

    public InfraHealthController(InfraHealthService healthService) {
        this.healthService = healthService;
    }

    @GetMapping("/ping")
    public ApiResponse<Map<String, Object>> ping() {
        Map<String, Object> data = new LinkedHashMap<>();
        data.put("service", "pipewise-api");
        data.put("status", "UP");
        data.put("time", Instant.now().toString());
        return ApiResponse.ok(data, traceId());
    }

    @GetMapping("/infra/health")
    public ApiResponse<Map<String, Object>> infraHealth() {
        return ApiResponse.ok(healthService.check(), traceId());
    }

    private String traceId() {
        return MDC.get(TraceIdFilter.TRACE_ID);
    }
}
