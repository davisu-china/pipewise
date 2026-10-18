package com.pipewise.flowable.service;

import com.pipewise.flowable.api.ApiException;
import com.pipewise.flowable.api.Dtos;
import org.flowable.engine.HistoryService;
import org.flowable.engine.RepositoryService;
import org.flowable.engine.RuntimeService;
import org.flowable.engine.TaskService;
import org.flowable.engine.history.HistoricProcessInstance;
import org.flowable.engine.history.HistoricProcessInstanceQuery;
import org.flowable.engine.repository.ProcessDefinition;
import org.flowable.engine.runtime.ProcessInstance;
import org.flowable.task.api.Task;
import org.flowable.task.api.history.HistoricTaskInstance;
import org.flowable.variable.api.history.HistoricVariableInstance;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.Date;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 骨架的核心业务层。
 *
 * <p>刻意把"Flowable 原生能力"和"我们自己的产品语义"分开放：
 * <ul>
 *   <li>流程/任务/历史查询直接走 Flowable 的 Service；</li>
 *   <li>签核计数、结果判定、字段白名单、实例权限、幂等是我们自己的规则。</li>
 * </ul>
 */
@Service
public class WorkflowService {

    private static final String ADMIN = "u_admin";

    /** 骨架阶段按任务节点给出可编辑字段；真实产品应来自"节点 × 字段权限矩阵"。 */
    private static final Map<String, List<String>> EDITABLE_FIELDS = Map.of(
            "mgr", List.of("mgr_comment"),
            "hr", List.of("hr_comment"),
            "vp", List.of("vp_comment"),
            "sign", List.of("sign_comment")
    );

    private final RuntimeService runtimeService;
    private final TaskService taskService;
    private final RepositoryService repositoryService;
    private final HistoryService historyService;

    public WorkflowService(
            RuntimeService runtimeService,
            TaskService taskService,
            RepositoryService repositoryService,
            HistoryService historyService
    ) {
        this.runtimeService = runtimeService;
        this.taskService = taskService;
        this.repositoryService = repositoryService;
        this.historyService = historyService;
    }

    // ---------------------------------------------------------------- 流程定义

    public List<Dtos.ProcessDto> listProcesses() {
        List<ProcessDefinition> definitions = new ArrayList<>(
                repositoryService.createProcessDefinitionQuery().latestVersion().list()
        );
        definitions.sort(Comparator.comparing(ProcessDefinition::getKey));
        return definitions.stream()
                .map(d -> new Dtos.ProcessDto(d.getKey(), d.getName(), d.getVersion(), d.getId()))
                .toList();
    }

    // ---------------------------------------------------------------- 发起

    @Transactional
    public Dtos.InstanceDto start(String definitionKey, String user, Dtos.StartRequest request) {
        requireUser(user);
        if (request == null || isBlank(request.businessKey())) {
            throw ApiException.badRequest("businessKey 必填");
        }
        ProcessDefinition definition = repositoryService.createProcessDefinitionQuery()
                .processDefinitionKey(definitionKey)
                .latestVersion()
                .singleResult();
        if (definition == null) {
            throw ApiException.notFound("流程定义不存在：" + definitionKey);
        }

        // 业务幂等：同一流程 + 业务单号只创建一个实例（运行中或已结束都算）。
        HistoricProcessInstance existing = historyService.createHistoricProcessInstanceQuery()
                .processDefinitionKey(definitionKey)
                .processInstanceBusinessKey(request.businessKey())
                .singleResult();
        if (existing != null) {
            return getInstance(existing.getId(), user);
        }

        Map<String, Object> variables = new LinkedHashMap<>();
        if (request.variables() != null) {
            variables.putAll(request.variables());
        }
        variables.put("initiator", user);
        variables.put("title", isBlank(request.title()) ? definition.getName() : request.title());
        variables.put("decisionMode", decisionMode(definitionKey));
        variables.put("approveCount", 0);
        variables.put("rejectCount", 0);

        if ("leave_approval".equals(definitionKey)) {
            variables.putIfAbsent("manager", "u_lisi");
            variables.putIfAbsent("hr", "u_wangfang");
            variables.putIfAbsent("vp", "u_zhangwei");
        } else {
            List<String> assignees = request.assignees();
            if (assignees == null || assignees.isEmpty()) {
                assignees = List.of("u_lisi", "u_wangfang", "u_zhangwei");
            }
            variables.putIfAbsent("assignees", new ArrayList<>(assignees));
        }

        ProcessInstance instance = runtimeService.startProcessInstanceById(
                definition.getId(), request.businessKey(), variables);
        runtimeService.setProcessInstanceName(instance.getId(), String.valueOf(variables.get("title")));
        return getInstance(instance.getId(), user);
    }

    // ---------------------------------------------------------------- 待办

    public List<Dtos.TaskDto> listTasks(String user, String status) {
        requireUser(user);
        boolean done = "done".equalsIgnoreCase(status);
        if (done) {
            var query = historyService.createHistoricTaskInstanceQuery()
                    .finished()
                    .orderByHistoricTaskInstanceEndTime().desc();
            if (!ADMIN.equals(user)) {
                query = query.taskAssignee(user);
            }
            return query.list().stream().map(this::toTaskDto).toList();
        }

        var query = taskService.createTaskQuery().orderByTaskCreateTime().desc();
        if (!ADMIN.equals(user)) {
            query = query.taskAssignee(user);
        }
        return query.list().stream().map(this::toTaskDto).toList();
    }

    public Dtos.TaskDetailDto getTask(String taskId, String user) {
        requireUser(user);
        Task task = taskService.createTaskQuery().taskId(taskId).singleResult();
        if (task != null) {
            requireTaskAccess(task.getAssignee(), user);
            String pid = task.getProcessInstanceId();
            return new Dtos.TaskDetailDto(
                    toTaskDto(task),
                    variablesOf(pid),
                    EDITABLE_FIELDS.getOrDefault(task.getTaskDefinitionKey(), List.of()),
                    instanceStatus(pid)
            );
        }

        HistoricTaskInstance historic = historyService.createHistoricTaskInstanceQuery()
                .taskId(taskId)
                .singleResult();
        if (historic == null) {
            throw ApiException.notFound("任务不存在：" + taskId);
        }
        requireTaskAccess(historic.getAssignee(), user);
        return new Dtos.TaskDetailDto(
                toTaskDto(historic),
                variablesOf(historic.getProcessInstanceId()),
                List.of(),
                instanceStatus(historic.getProcessInstanceId())
        );
    }

    /**
     * 完成任务。verdict 写入 lastVerdict，BPMN 里的 VerdictListener 会累加 approveCount/rejectCount；
     * data 只接受当前节点白名单里的字段，越权字段静默丢弃（与 PipeWise 的表单权限策略一致）。
     */
    @Transactional
    public Dtos.InstanceDto completeTask(String taskId, String user, Dtos.CompleteRequest request) {
        requireUser(user);
        Task task = taskService.createTaskQuery().taskId(taskId).singleResult();
        if (task == null) {
            throw ApiException.conflict("任务已被处理或不存在");
        }
        requireTaskAccess(task.getAssignee(), user);

        String verdict = request == null ? null : request.verdict();
        if (!"approve".equals(verdict) && !"reject".equals(verdict)) {
            throw ApiException.badRequest("verdict 只能是 approve 或 reject");
        }

        Map<String, Object> variables = new LinkedHashMap<>();
        variables.put("lastVerdict", verdict);
        variables.put("lastComment", request.comment());

        List<String> allowed = EDITABLE_FIELDS.getOrDefault(task.getTaskDefinitionKey(), List.of());
        if (request.data() != null) {
            for (String field : allowed) {
                if (request.data().containsKey(field)) {
                    variables.put(field, request.data().get(field));
                }
            }
        }

        String pid = task.getProcessInstanceId();
        taskService.complete(taskId, variables);
        return getInstance(pid, user);
    }

    // ---------------------------------------------------------------- 实例

    public List<Dtos.InstanceDto> listInstances(String user) {
        requireUser(user);
        HistoricProcessInstanceQuery query = historyService.createHistoricProcessInstanceQuery()
                .orderByProcessInstanceStartTime().desc();
        if (!ADMIN.equals(user)) {
            query = query.variableValueEquals("initiator", user);
        }
        return query.list().stream().map(this::toInstanceDto).toList();
    }

    public Dtos.InstanceDto getInstance(String instanceId, String user) {
        requireUser(user);
        HistoricProcessInstance instance = historyService.createHistoricProcessInstanceQuery()
                .processInstanceId(instanceId)
                .singleResult();
        if (instance == null) {
            throw ApiException.notFound("实例不存在：" + instanceId);
        }

        Map<String, Object> variables = variablesOf(instanceId);
        String initiator = asString(variables.get("initiator"));
        if (!user.equals(initiator) && !ADMIN.equals(user) && !isInvolved(instanceId, user)) {
            throw ApiException.forbidden("无权查看这个实例");
        }
        return toInstanceDto(instance, variables);
    }

    // ---------------------------------------------------------------- 内部工具

    private Dtos.InstanceDto toInstanceDto(HistoricProcessInstance instance) {
        return toInstanceDto(instance, variablesOf(instance.getId()));
    }

    private Dtos.InstanceDto toInstanceDto(HistoricProcessInstance instance, Map<String, Object> variables) {
        String status = instanceStatus(instance);
        ProcessDefinition definition = repositoryService.getProcessDefinition(instance.getProcessDefinitionId());
        String definitionName = definition != null ? definition.getName() : instance.getProcessDefinitionKey();
        String title = asString(variables.get("title"));
        if (title == null) {
            title = instance.getName();
        }
        String result = instance.getEndTime() == null ? null : computeResult(variables);

        List<Map<String, Object>> active = taskService.createTaskQuery()
                .processInstanceId(instance.getId())
                .orderByTaskCreateTime().asc()
                .list().stream()
                .map(t -> {
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("id", t.getId());
                    item.put("name", t.getName());
                    item.put("taskDefinitionKey", t.getTaskDefinitionKey());
                    item.put("assignee", t.getAssignee());
                    item.put("createTime", iso(t.getCreateTime()));
                    return item;
                }).toList();

        List<Map<String, Object>> history = historyService.createHistoricTaskInstanceQuery()
                .processInstanceId(instance.getId())
                .finished()
                .orderByHistoricTaskInstanceEndTime().asc()
                .list().stream()
                .map(t -> {
                    Map<String, Object> item = new LinkedHashMap<>();
                    item.put("id", t.getId());
                    item.put("name", t.getName());
                    item.put("taskDefinitionKey", t.getTaskDefinitionKey());
                    item.put("assignee", t.getAssignee());
                    item.put("status", t.getDeleteReason() == null ? "COMPLETED" : "CANCELLED");
                    item.put("endTime", iso(t.getEndTime()));
                    if (t.getDeleteReason() != null) {
                        item.put("deleteReason", t.getDeleteReason());
                    }
                    return item;
                }).toList();

        return new Dtos.InstanceDto(
                instance.getId(),
                instance.getProcessDefinitionKey(),
                definitionName,
                instance.getBusinessKey(),
                title,
                asString(variables.get("initiator")),
                status,
                result,
                iso(instance.getStartTime()),
                iso(instance.getEndTime()),
                active,
                history,
                variables
        );
    }

    private Dtos.TaskDto toTaskDto(Task task) {
        String pid = task.getProcessInstanceId();
        return new Dtos.TaskDto(
                task.getId(),
                task.getName(),
                task.getTaskDefinitionKey(),
                pid,
                processDefinitionKey(task.getProcessDefinitionId()),
                businessKeyOf(pid),
                asString(variableOf(pid, "title")),
                task.getAssignee(),
                "CREATED",
                iso(task.getCreateTime()),
                null
        );
    }

    private Dtos.TaskDto toTaskDto(HistoricTaskInstance task) {
        String pid = task.getProcessInstanceId();
        return new Dtos.TaskDto(
                task.getId(),
                task.getName(),
                task.getTaskDefinitionKey(),
                pid,
                processDefinitionKey(task.getProcessDefinitionId()),
                businessKeyOf(pid),
                asString(variableOf(pid, "title")),
                task.getAssignee(),
                task.getDeleteReason() == null ? "COMPLETED" : "CANCELLED",
                iso(task.getCreateTime()),
                iso(task.getEndTime())
        );
    }

    private Map<String, Object> variablesOf(String processInstanceId) {
        ProcessInstance running = runtimeService.createProcessInstanceQuery()
                .processInstanceId(processInstanceId)
                .singleResult();
        if (running != null) {
            return new LinkedHashMap<>(runtimeService.getVariables(processInstanceId));
        }
        Map<String, Object> out = new LinkedHashMap<>();
        List<HistoricVariableInstance> rows = historyService.createHistoricVariableInstanceQuery()
                .processInstanceId(processInstanceId)
                .excludeTaskVariables()
                .list();
        for (HistoricVariableInstance row : rows) {
            out.put(row.getVariableName(), row.getValue());
        }
        return out;
    }

    private Object variableOf(String processInstanceId, String name) {
        ProcessInstance running = runtimeService.createProcessInstanceQuery()
                .processInstanceId(processInstanceId)
                .singleResult();
        if (running != null) {
            return runtimeService.getVariable(processInstanceId, name);
        }
        HistoricVariableInstance row = historyService.createHistoricVariableInstanceQuery()
                .processInstanceId(processInstanceId)
                .variableName(name)
                .singleResult();
        return row != null ? row.getValue() : null;
    }

    private String businessKeyOf(String processInstanceId) {
        ProcessInstance running = runtimeService.createProcessInstanceQuery()
                .processInstanceId(processInstanceId)
                .singleResult();
        if (running != null) {
            return running.getBusinessKey();
        }
        HistoricProcessInstance historic = historyService.createHistoricProcessInstanceQuery()
                .processInstanceId(processInstanceId)
                .singleResult();
        return historic != null ? historic.getBusinessKey() : null;
    }

    private String instanceStatus(String processInstanceId) {
        ProcessInstance running = runtimeService.createProcessInstanceQuery()
                .processInstanceId(processInstanceId)
                .singleResult();
        if (running != null) {
            return "RUNNING";
        }
        HistoricProcessInstance historic = historyService.createHistoricProcessInstanceQuery()
                .processInstanceId(processInstanceId)
                .singleResult();
        if (historic == null) {
            return "UNKNOWN";
        }
        return instanceStatus(historic);
    }

    private String instanceStatus(HistoricProcessInstance instance) {
        if (instance.getEndTime() == null) {
            return "RUNNING";
        }
        return instance.getDeleteReason() == null ? "COMPLETED" : "TERMINATED";
    }

    private String computeResult(Map<String, Object> variables) {
        String mode = asString(variables.get("decisionMode"));
        int approve = asInt(variables.get("approveCount"));
        int reject = asInt(variables.get("rejectCount"));
        String last = asString(variables.get("lastVerdict"));
        if (mode == null) {
            mode = "s1";
        }
        return switch (mode) {
            case "or" -> approve > 0 ? "approved" : "rejected";
            case "all" -> reject > 0 ? "rejected" : "approved";
            case "race" -> "approve".equals(last) ? "approved" : "rejected";
            default -> reject > 0 ? "rejected" : "approved";
        };
    }

    private String decisionMode(String definitionKey) {
        return switch (definitionKey) {
            case "demo_or_sign" -> "or";
            case "demo_all_sign" -> "all";
            case "demo_race" -> "race";
            default -> "s1";
        };
    }

    private boolean isInvolved(String processInstanceId, String user) {
        long active = taskService.createTaskQuery()
                .processInstanceId(processInstanceId)
                .taskAssignee(user)
                .count();
        if (active > 0) {
            return true;
        }
        return historyService.createHistoricTaskInstanceQuery()
                .processInstanceId(processInstanceId)
                .taskAssignee(user)
                .count() > 0;
    }

    private void requireTaskAccess(String assignee, String user) {
        if (!user.equals(assignee) && !ADMIN.equals(user)) {
            throw ApiException.forbidden("这条任务不是指派给你的");
        }
    }

    private void requireUser(String user) {
        if (!DemoUsers.exists(user)) {
            throw ApiException.unauthorized("未知的演示用户：" + user);
        }
    }

    private String processDefinitionKey(String processDefinitionId) {
        ProcessDefinition definition = repositoryService.getProcessDefinition(processDefinitionId);
        return definition != null ? definition.getKey() : null;
    }

    private static boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private static String asString(Object value) {
        return value == null ? null : String.valueOf(value);
    }

    private static int asInt(Object value) {
        return value instanceof Number number ? number.intValue() : 0;
    }

    private static String iso(Date date) {
        return date == null ? null : date.toInstant().toString();
    }
}
