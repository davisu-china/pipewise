package com.pipewise.flowable.service;

import org.flowable.engine.delegate.TaskListener;
import org.flowable.task.service.delegate.DelegateTask;
import org.springframework.stereotype.Component;

/**
 * 任务完成时累加同意/否决票数。
 *
 * <p>BPMN 的多实例完成条件只依赖两个计数器：
 * <pre>
 *   或签: approveCount &gt; 0 || nrOfCompletedInstances == nrOfInstances
 *   并签: rejectCount &gt; 0  || nrOfCompletedInstances == nrOfInstances
 *   竞签: nrOfCompletedInstances &gt;= 1
 * </pre>
 * 把“签核裁决”从引擎的 completionCondition 里抽到一个监听器，
 * 好处是 BPMN XML 保持简单，规则也只有一处实现。
 */
@Component("verdictListener")
public class VerdictListener implements TaskListener {

    @Override
    public void notify(DelegateTask task) {
        Object raw = task.getVariable("lastVerdict");
        if (raw == null) {
            return;
        }
        int approve = asInt(task.getVariable("approveCount"));
        int reject = asInt(task.getVariable("rejectCount"));
        if ("approve".equals(String.valueOf(raw))) {
            approve++;
        } else if ("reject".equals(String.valueOf(raw))) {
            reject++;
        }
        // approveCount/rejectCount 在发起时已存在于流程级作用域，这里更新的是流程变量。
        task.setVariable("approveCount", approve);
        task.setVariable("rejectCount", reject);
    }

    private static int asInt(Object value) {
        return value instanceof Number number ? number.intValue() : 0;
    }
}
