package com.pipewise.engine;

import com.pipewise.engine.EngineRepository.InstanceRow;
import com.pipewise.engine.model.FlowModel.EdgeDef;
import com.pipewise.engine.model.FlowModel.FlowDefinition;
import com.pipewise.engine.model.FlowModel.NodeDef;
import org.springframework.stereotype.Component;

/**
 * 把令牌从当前节点推进到所有出边目标。P2 暂不评估条件，出边全部激活；
 * 条件表达式与并行汇聚在 P4 实现。
 */
@Component
public class TokenAdvancer {

    private final EngineRepository repository;

    public TokenAdvancer(EngineRepository repository) {
        this.repository = repository;
    }

    public int advance(InstanceRow instance, FlowDefinition flow, NodeDef node, long parentTokenId) {
        int count = 0;
        for (EdgeDef edge : flow.outgoing(node.id())) {
            if (edge.to() == null || edge.to().isBlank()) {
                continue;
            }
            long tokenId = repository.insertToken(instance.id(), edge.to(), parentTokenId, instance.round());
            repository.insertJob(instance.id(), null, "ACTIVATE_TOKEN", tokenId);
            count++;
        }
        return count;
    }
}
