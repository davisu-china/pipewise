package com.pipewise.flowable.api;

import com.pipewise.flowable.service.WorkflowService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/processes")
public class ProcessController {

    private final WorkflowService workflowService;

    public ProcessController(WorkflowService workflowService) {
        this.workflowService = workflowService;
    }

    @GetMapping
    public List<Dtos.ProcessDto> list() {
        return workflowService.listProcesses();
    }

    @PostMapping("/{key}/start")
    public Dtos.InstanceDto start(
            @PathVariable String key,
            @RequestHeader(value = "X-Demo-User", defaultValue = "u_zhangsan") String user,
            @RequestBody(required = false) Dtos.StartRequest request
    ) {
        return workflowService.start(key, user, request);
    }
}
