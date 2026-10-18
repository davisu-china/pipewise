package com.pipewise.flowable.api;

import com.pipewise.flowable.service.WorkflowService;
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
@RequestMapping("/api/tasks")
public class TaskController {

    private final WorkflowService workflowService;

    public TaskController(WorkflowService workflowService) {
        this.workflowService = workflowService;
    }

    @GetMapping
    public List<Dtos.TaskDto> list(
            @RequestHeader(value = "X-Demo-User", defaultValue = "u_zhangsan") String user,
            @RequestParam(defaultValue = "pending") String status
    ) {
        return workflowService.listTasks(user, status);
    }

    @GetMapping("/{id}")
    public Dtos.TaskDetailDto detail(
            @PathVariable String id,
            @RequestHeader(value = "X-Demo-User", defaultValue = "u_zhangsan") String user
    ) {
        return workflowService.getTask(id, user);
    }

    @PostMapping("/{id}/complete")
    public Dtos.InstanceDto complete(
            @PathVariable String id,
            @RequestHeader(value = "X-Demo-User", defaultValue = "u_zhangsan") String user,
            @RequestBody Dtos.CompleteRequest request
    ) {
        return workflowService.completeTask(id, user, request);
    }
}
