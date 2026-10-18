package com.pipewise.flowable.api;

import com.pipewise.flowable.service.WorkflowService;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestHeader;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/instances")
public class InstanceController {

    private final WorkflowService workflowService;

    public InstanceController(WorkflowService workflowService) {
        this.workflowService = workflowService;
    }

    @GetMapping
    public List<Dtos.InstanceDto> list(
            @RequestHeader(value = "X-Demo-User", defaultValue = "u_zhangsan") String user
    ) {
        return workflowService.listInstances(user);
    }

    @GetMapping("/{id}")
    public Dtos.InstanceDto detail(
            @PathVariable String id,
            @RequestHeader(value = "X-Demo-User", defaultValue = "u_zhangsan") String user
    ) {
        return workflowService.getInstance(id, user);
    }
}
