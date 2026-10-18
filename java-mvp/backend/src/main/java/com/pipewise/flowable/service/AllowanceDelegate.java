package com.pipewise.flowable.service;

import org.flowable.engine.delegate.DelegateExecution;
import org.flowable.engine.delegate.JavaDelegate;
import org.springframework.stereotype.Component;

/** S1 请假流程里的服务任务：把脚本节点的计算换成 Java Delegate，演示 BPMN serviceTask。 */
@Component("allowanceDelegate")
public class AllowanceDelegate implements JavaDelegate {

    @Override
    public void execute(DelegateExecution execution) {
        Object raw = execution.getVariable("leave_days");
        double days = raw instanceof Number number ? number.doubleValue() : 0d;
        execution.setVariable("allowance", days * 500);
        execution.setVariable("leave_left", Math.max(0, 15 - days));
    }
}
