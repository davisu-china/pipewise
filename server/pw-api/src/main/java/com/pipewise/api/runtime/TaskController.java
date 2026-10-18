package com.pipewise.api.runtime;

import com.pipewise.api.web.TraceIdFilter;
import com.pipewise.common.api.ApiResponse;
import com.pipewise.engine.EngineDtos.AssigneeRequest;
import com.pipewise.engine.EngineDtos.CompleteTaskRequest;
import com.pipewise.engine.EngineDtos.TaskView;
import com.pipewise.engine.TaskService;
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
@RequestMapping("/api/v1/tasks")
public class TaskController {

    private final TaskService service;

    public TaskController(TaskService service) {
        this.service = service;
    }

    @GetMapping
    public ApiResponse<List<TaskView>> list(
            @RequestParam(required = false) String status,
            @RequestHeader(value = "X-User-Id", defaultValue = "anonymous") String user) {
        return ApiResponse.ok(service.list(user, status), traceId());
    }

    @GetMapping("/{id}")
    public ApiResponse<TaskView> get(@PathVariable long id) {
        return ApiResponse.ok(service.get(id), traceId());
    }

    @PostMapping("/{id}/add-sign")
    public ApiResponse<TaskView> addSign(
            @PathVariable long id,
            @Valid @RequestBody AssigneeRequest request,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant,
            @RequestHeader(value = "X-User-Id", defaultValue = "anonymous") String user) {
        return ApiResponse.ok(service.addSign(tenant, id, user, request.assignee()), traceId());
    }

    @PostMapping("/{id}/transfer")
    public ApiResponse<TaskView> transfer(
            @PathVariable long id,
            @Valid @RequestBody AssigneeRequest request,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant,
            @RequestHeader(value = "X-User-Id", defaultValue = "anonymous") String user) {
        return ApiResponse.ok(service.transfer(tenant, id, user, request.assignee()), traceId());
    }

    @PostMapping("/{id}/complete")
    public ApiResponse<TaskView> complete(
            @PathVariable long id,
            @Valid @RequestBody CompleteTaskRequest request,
            @RequestHeader(value = "X-Tenant-Id", defaultValue = "default") String tenant,
            @RequestHeader(value = "X-User-Id", defaultValue = "anonymous") String user) {
        return ApiResponse.ok(service.complete(tenant, id, user, request), traceId());
    }

    private String traceId() {
        return MDC.get(TraceIdFilter.TRACE_ID);
    }
}
