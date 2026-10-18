package com.pipewise.flowable.api;

import java.util.List;
import java.util.Map;

/** 面向前端的 DTO。骨架阶段直接暴露 Flowable 的必要字段，不把引擎实体序列化出去。 */
public final class Dtos {

    private Dtos() {
    }

    public record UserDto(String id, String name) {
    }

    public record ProcessDto(String key, String name, int version, String definitionId) {
    }

    public record StartRequest(
            String businessKey,
            String title,
            Map<String, Object> variables,
            List<String> assignees
    ) {
    }

    public record CompleteRequest(String verdict, String comment, Map<String, Object> data) {
    }

    public record TaskDto(
            String id,
            String name,
            String taskDefinitionKey,
            String processInstanceId,
            String processDefinitionKey,
            String businessKey,
            String title,
            String assignee,
            String status,
            String createTime,
            String endTime
    ) {
    }

    public record TaskDetailDto(
            TaskDto task,
            Map<String, Object> variables,
            List<String> editableFields,
            String instanceStatus
    ) {
    }

    public record InstanceDto(
            String id,
            String processDefinitionKey,
            String processDefinitionName,
            String businessKey,
            String title,
            String initiator,
            String status,
            String result,
            String startTime,
            String endTime,
            List<Map<String, Object>> activeTasks,
            List<Map<String, Object>> taskHistory,
            Map<String, Object> variables
    ) {
    }

    public record ErrorDto(String code, String message) {
    }

    public record ErrorEnvelope(ErrorDto error) {
    }
}
