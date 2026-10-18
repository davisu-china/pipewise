package com.pipewise.api.definition;

import com.pipewise.api.definition.DefinitionDtos.EdgeDef;
import com.pipewise.api.definition.DefinitionDtos.FlowDefinition;
import com.pipewise.api.definition.DefinitionDtos.NodeDef;
import com.pipewise.api.definition.DefinitionDtos.ValidationIssue;
import com.pipewise.api.definition.DefinitionDtos.ValidationResult;
import com.pipewise.api.definition.DefinitionDtos.VariableDef;
import org.springframework.stereotype.Component;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * P1 发布前校验：只做结构与引用检查，不执行脚本、不解析组织架构。
 */
@Component
public class DefinitionValidator {

    private static final Set<String> NODE_TYPES = Set.of(
            "start", "end", "approval", "form", "cc", "script", "service",
            "exclusive_gateway", "parallel_gateway", "inclusive_gateway",
            "timer", "wait", "sub_process", "plugin");

    private static final Set<String> VARIABLE_TYPES = Set.of(
            "string", "number", "decimal", "bool", "date", "datetime",
            "json", "object", "array", "file", "user", "org");

    private static final Set<String> SIGN_MODES = Set.of("any", "all", "race");
    private static final Set<String> SYSTEM_VARIABLES = Set.of("verdict", "signResult", "initiator");
    private static final Pattern CTX_REF = Pattern.compile("ctx\\.([A-Za-z_][A-Za-z0-9_]*)");

    public ValidationResult validate(FlowDefinition flow) {
        List<ValidationIssue> issues = new ArrayList<>();
        if (flow == null) {
            issues.add(issue("EMPTY_DEFINITION", "流程定义为空", null, null));
            return new ValidationResult(false, issues);
        }

        List<NodeDef> nodes = flow.nodes() == null ? List.of() : flow.nodes();
        List<EdgeDef> edges = flow.edges() == null ? List.of() : flow.edges();
        List<VariableDef> variables = flow.variables() == null ? List.of() : flow.variables();

        if (nodes.isEmpty()) {
            issues.add(issue("NO_NODES", "至少需要一个节点", null, null));
        }

        Map<String, NodeDef> nodeById = new HashMap<>();
        for (NodeDef node : nodes) {
            if (isBlank(node.id())) {
                issues.add(issue("NODE_ID_EMPTY", "节点 id 不能为空", null, null));
                continue;
            }
            if (nodeById.putIfAbsent(node.id(), node) != null) {
                issues.add(issue("DUPLICATE_NODE_ID", "节点 id 重复: " + node.id(), node.id(), null));
            }
            if (isBlank(node.type()) || !NODE_TYPES.contains(node.type())) {
                issues.add(issue("UNKNOWN_NODE_TYPE", "未知节点类型: " + node.type(), node.id(), null));
            }
        }

        long startCount = nodes.stream().filter(n -> "start".equals(n.type())).count();
        long endCount = nodes.stream().filter(n -> "end".equals(n.type())).count();
        if (startCount != 1) {
            issues.add(issue("START_COUNT", "必须有且仅有一个 start 节点，当前 " + startCount + " 个", null, null));
        }
        if (endCount < 1) {
            issues.add(issue("END_COUNT", "至少需要一个 end 节点", null, null));
        }

        Set<String> variableNames = new HashSet<>();
        for (VariableDef variable : variables) {
            if (isBlank(variable.name())) {
                issues.add(issue("VARIABLE_NAME_EMPTY", "变量名不能为空", null, null));
                continue;
            }
            if (!variableNames.add(variable.name())) {
                issues.add(issue("DUPLICATE_VARIABLE", "变量名重复: " + variable.name(), null, null));
            }
            if (isBlank(variable.type()) || !VARIABLE_TYPES.contains(variable.type())) {
                issues.add(issue("VARIABLE_TYPE", "变量 " + variable.name() + " 的类型不合法: " + variable.type(), null, null));
            }
        }

        Set<String> edgeIds = new HashSet<>();
        Map<String, List<EdgeDef>> outgoing = new HashMap<>();
        Map<String, List<EdgeDef>> incoming = new HashMap<>();
        for (EdgeDef edge : edges) {
            if (isBlank(edge.id())) {
                issues.add(issue("EDGE_ID_EMPTY", "边 id 不能为空", null, null));
            } else if (!edgeIds.add(edge.id())) {
                issues.add(issue("DUPLICATE_EDGE_ID", "边 id 重复: " + edge.id(), null, edge.id()));
            }
            if (edge.from() == null || !nodeById.containsKey(edge.from())) {
                issues.add(issue("EDGE_FROM_MISSING", "边的起点不存在: " + edge.from(), null, edge.id()));
            }
            if (edge.to() == null || !nodeById.containsKey(edge.to())) {
                issues.add(issue("EDGE_TO_MISSING", "边的终点不存在: " + edge.to(), null, edge.id()));
            }
            outgoing.computeIfAbsent(edge.from(), key -> new ArrayList<>()).add(edge);
            incoming.computeIfAbsent(edge.to(), key -> new ArrayList<>()).add(edge);

            checkConditionVariables(edge, variableNames, issues);
        }

        for (NodeDef node : nodes) {
            String type = node.type();
            List<EdgeDef> in = incoming.getOrDefault(node.id(), List.of());
            List<EdgeDef> out = outgoing.getOrDefault(node.id(), List.of());
            if (!"start".equals(type) && in.isEmpty()) {
                issues.add(issue("NODE_NO_INCOMING", "节点没有入边: " + node.id(), node.id(), null));
            }
            if (!"end".equals(type) && out.isEmpty()) {
                issues.add(issue("NODE_NO_OUTGOING", "节点没有出边: " + node.id(), node.id(), null));
            }
            if ("start".equals(type) && !in.isEmpty()) {
                issues.add(issue("START_HAS_INCOMING", "start 节点不能有入边", node.id(), null));
            }
            if ("end".equals(type) && !out.isEmpty()) {
                issues.add(issue("END_HAS_OUTGOING", "end 节点不能有出边", node.id(), null));
            }
            if ("approval".equals(type)) {
                String signMode = text(node, "signMode");
                if (!isBlank(signMode) && !SIGN_MODES.contains(signMode)) {
                    issues.add(issue("SIGN_MODE", "审批节点的 signMode 不合法: " + signMode, node.id(), null));
                }
            }
            if ("script".equals(type) && isBlank(text(node, "scriptRef")) && isBlank(text(node, "scriptVersionId"))) {
                issues.add(issue("SCRIPT_REF", "脚本节点缺少 scriptRef/scriptVersionId", node.id(), null));
            }
            if ("form".equals(type) && isBlank(text(node, "formRef"))) {
                issues.add(issue("FORM_REF", "表单节点缺少 formRef", node.id(), null));
            }
            if ("exclusive_gateway".equals(type)) {
                checkExclusiveGateway(node, out, issues);
            }
        }

        checkReachability(nodeById, outgoing, issues);
        return new ValidationResult(issues.isEmpty(), issues);
    }

    private void checkExclusiveGateway(NodeDef node, List<EdgeDef> outgoing, List<ValidationIssue> issues) {
        if (outgoing.isEmpty()) {
            return;
        }
        long defaults = outgoing.stream().filter(this::isDefaultEdge).count();
        if (defaults != 1) {
            issues.add(issue("XOR_DEFAULT_EDGE",
                    "排他网关必须恰好有一条默认边，当前 " + defaults + " 条", node.id(), null));
        }
        for (EdgeDef edge : outgoing) {
            if (!isDefaultEdge(edge) && isBlank(edge.condition())) {
                issues.add(issue("XOR_CONDITION_MISSING",
                        "排他网关的非默认边必须配置条件", node.id(), edge.id()));
            }
        }
    }

    private boolean isDefaultEdge(EdgeDef edge) {
        return Boolean.TRUE.equals(edge.defaultEdge())
                || isBlank(edge.condition())
                || "true".equalsIgnoreCase(edge.condition().trim());
    }

    private void checkConditionVariables(EdgeDef edge, Set<String> declared, List<ValidationIssue> issues) {
        if (isBlank(edge.condition())) {
            return;
        }
        Matcher matcher = CTX_REF.matcher(edge.condition());
        while (matcher.find()) {
            String name = matcher.group(1);
            if (!declared.contains(name) && !SYSTEM_VARIABLES.contains(name)) {
                issues.add(issue("UNKNOWN_VARIABLE",
                        "条件引用了未声明的变量: ctx." + name, null, edge.id()));
            }
        }
    }

    private void checkReachability(Map<String, NodeDef> nodeById,
                                   Map<String, List<EdgeDef>> outgoing,
                                   List<ValidationIssue> issues) {
        String startId = nodeById.values().stream()
                .filter(node -> "start".equals(node.type()))
                .map(NodeDef::id)
                .findFirst()
                .orElse(null);
        if (startId == null) {
            return;
        }
        Set<String> visited = new HashSet<>();
        ArrayDeque<String> queue = new ArrayDeque<>();
        queue.add(startId);
        while (!queue.isEmpty()) {
            String current = queue.removeFirst();
            if (!visited.add(current)) {
                continue;
            }
            for (EdgeDef edge : outgoing.getOrDefault(current, List.of())) {
                if (edge.to() != null && !visited.contains(edge.to())) {
                    queue.addLast(edge.to());
                }
            }
        }
        for (String nodeId : nodeById.keySet()) {
            if (!visited.contains(nodeId)) {
                issues.add(issue("UNREACHABLE_NODE", "节点从 start 不可达: " + nodeId, nodeId, null));
            }
        }
    }

    private String text(NodeDef node, String field) {
        if (node.config() == null) {
            return null;
        }
        var value = node.config().get(field);
        return value == null || value.isNull() ? null : value.asText();
    }

    private ValidationIssue issue(String code, String message, String nodeId, String edgeId) {
        return new ValidationIssue(code, message, nodeId, edgeId);
    }

    private boolean isBlank(String value) {
        return value == null || value.isBlank();
    }
}
