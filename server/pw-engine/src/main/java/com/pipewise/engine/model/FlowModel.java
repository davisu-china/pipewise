package com.pipewise.engine.model;

import com.fasterxml.jackson.databind.JsonNode;

import java.util.List;

/**
 * 运行期快照模型：与 wf_definition_version.snapshot_json 一一对应。
 */
public final class FlowModel {

    private FlowModel() {
    }

    public record Position(Double x, Double y) {
    }

    public record VariableDef(String name, String type, Boolean required, JsonNode defaultValue) {
    }

    public record NodeDef(String id, String type, String name, Position position, JsonNode config) {
    }

    public record EdgeDef(
            String id,
            String from,
            String to,
            String condition,
            Boolean defaultEdge,
            Integer order) {
    }

    public record Settings(Integer maxSteps, Integer maxNodeActivations, String timezone) {
    }

    public record FlowDefinition(
            String key,
            String name,
            String tenant,
            Integer version,
            Settings settings,
            List<VariableDef> variables,
            List<NodeDef> nodes,
            List<EdgeDef> edges) {

        public FlowDefinition withVersion(int newVersion) {
            return new FlowDefinition(key, name, tenant, newVersion, settings, variables, nodes, edges);
        }

        public NodeDef node(String nodeId) {
            if (nodes == null) {
                return null;
            }
            return nodes.stream().filter(node -> node.id().equals(nodeId)).findFirst().orElse(null);
        }

        public List<EdgeDef> outgoing(String nodeId) {
            if (edges == null) {
                return List.of();
            }
            return edges.stream().filter(edge -> nodeId.equals(edge.from())).toList();
        }
    }
}
