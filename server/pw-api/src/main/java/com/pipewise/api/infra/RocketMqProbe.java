package com.pipewise.api.infra;

import com.pipewise.api.config.PipeWiseProperties;
import org.apache.rocketmq.acl.common.AclClientRPCHook;
import org.apache.rocketmq.acl.common.SessionCredentials;
import org.apache.rocketmq.client.producer.DefaultMQProducer;
import org.apache.rocketmq.client.producer.SendResult;
import org.apache.rocketmq.common.message.Message;
import org.springframework.stereotype.Component;

import java.nio.charset.StandardCharsets;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * P0 只做一次真实发送，验证 nameserver、broker 与 ACL 是否都通。
 */
@Component
public class RocketMqProbe {

    private final PipeWiseProperties properties;

    public RocketMqProbe(PipeWiseProperties properties) {
        this.properties = properties;
    }

    public Map<String, Object> check() {
        PipeWiseProperties.Rocketmq rocketmq = properties.getRocketmq();
        if (isBlank(rocketmq.getNamesrv())) {
            return status("SKIPPED", "PW_ROCKETMQ_NAMESRV 未配置");
        }

        DefaultMQProducer producer = null;
        try {
            producer = createProducer(rocketmq);
            producer.setNamesrvAddr(rocketmq.getNamesrv());
            producer.setSendMsgTimeout(3000);
            producer.setVipChannelEnabled(false);
            producer.start();
            SendResult result = producer.send(new Message(
                    rocketmq.getTopic(),
                    "pipewise-health".getBytes(StandardCharsets.UTF_8)));
            return status("UP", "send=" + result.getSendStatus() + ", msgId=" + result.getMsgId());
        } catch (Exception ex) {
            return status("DOWN", safeMessage(ex));
        } finally {
            if (producer != null) {
                producer.shutdown();
            }
        }
    }

    private DefaultMQProducer createProducer(PipeWiseProperties.Rocketmq rocketmq) {
        if (isBlank(rocketmq.getAccessKey())) {
            return new DefaultMQProducer("pipewise_health_producer");
        }
        return new DefaultMQProducer(
                "pipewise_health_producer",
                new AclClientRPCHook(new SessionCredentials(
                        rocketmq.getAccessKey(), rocketmq.getSecretKey())));
    }

    private Map<String, Object> status(String status, String detail) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("status", status);
        item.put("detail", detail);
        return item;
    }

    private boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private String safeMessage(Exception ex) {
        String message = ex.getMessage();
        return message == null || message.isBlank() ? ex.getClass().getSimpleName() : message;
    }
}
