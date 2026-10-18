package com.pipewise.api.definition;

import com.fasterxml.jackson.databind.node.JsonNodeFactory;
import com.pipewise.engine.model.FlowModel.EdgeDef;
import com.pipewise.engine.model.FlowModel.FlowDefinition;
import com.pipewise.engine.model.FlowModel.NodeDef;
import com.pipewise.engine.model.FlowModel.Position;
import com.pipewise.api.definition.DefinitionDtos.ValidationIssue;
import com.pipewise.api.definition.DefinitionDtos.ValidationResult;
import com.pipewise.engine.model.FlowModel.VariableDef;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class DefinitionValidatorTest {

    private final DefinitionValidator validator = new DefinitionValidator();

    @Test
    void acceptsSimpleApprovalFlow() {
        FlowDefinition flow = flow(
                List.of(node("start", "start"), node("mgr", "approval"), node("end", "end")),
                List.of(
                        edge("e1", "start", "mgr", null, false),
                        edge("e2", "mgr", "end", "verdict == 'approve'", false)),
                List.of());

        ValidationResult result = validator.validate(flow);

        assertThat(result.valid()).isTrue();
        assertThat(result.issues()).isEmpty();
    }

    @Test
    void rejectsMissingStart() {
        FlowDefinition flow = flow(
                List.of(node("mgr", "approval"), node("end", "end")),
                List.of(edge("e1", "mgr", "end", null, false)),
                List.of());

        ValidationResult result = validator.validate(flow);

        assertThat(result.valid()).isFalse();
        assertThat(codes(result)).contains("START_COUNT");
    }

    @Test
    void xorGatewayRequiresExactlyOneDefaultEdge() {
        FlowDefinition flow = flow(
                List.of(node("start", "start"), node("gw", "exclusive_gateway"), node("end", "end")),
                List.of(
                        edge("e1", "start", "gw", null, false),
                        edge("e2", "gw", "end", "ctx.amount > 100", false)),
                List.of(variable("amount", "number")));

        ValidationResult result = validator.validate(flow);

        assertThat(result.valid()).isFalse();
        assertThat(codes(result)).contains("XOR_DEFAULT_EDGE");
    }

    @Test
    void rejectsUndeclaredContextVariable() {
        FlowDefinition flow = flow(
                List.of(node("start", "start"), node("mgr", "approval"), node("end", "end")),
                List.of(
                        edge("e1", "start", "mgr", "ctx.missing > 1", false),
                        edge("e2", "mgr", "end", null, false)),
                List.of());

        ValidationResult result = validator.validate(flow);

        assertThat(result.valid()).isFalse();
        assertThat(codes(result)).contains("UNKNOWN_VARIABLE");
    }

    private List<String> codes(ValidationResult result) {
        return result.issues().stream().map(ValidationIssue::code).toList();
    }

    private FlowDefinition flow(List<NodeDef> nodes, List<EdgeDef> edges, List<VariableDef> variables) {
        return new FlowDefinition("demo", "Demo", "default", null, null, variables, nodes, edges);
    }

    private NodeDef node(String id, String type) {
        return new NodeDef(id, type, id, new Position(0.0, 0.0), JsonNodeFactory.instance.objectNode());
    }

    private EdgeDef edge(String id, String from, String to, String condition, boolean isDefault) {
        return new EdgeDef(id, from, to, condition, isDefault, 1);
    }

    private VariableDef variable(String name, String type) {
        return new VariableDef(name, type, false, null);
    }
}
