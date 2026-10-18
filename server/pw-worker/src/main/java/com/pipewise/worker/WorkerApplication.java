package com.pipewise.worker;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.boot.SpringApplication;
import org.springframework.boot.autoconfigure.SpringBootApplication;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.Scheduled;

/**
 * P0 只保留进程与心跳。P2 开始在这里接入作业队列与令牌调度。
 */
@SpringBootApplication(scanBasePackages = "com.pipewise")
@EnableScheduling
public class WorkerApplication {

    private static final Logger log = LoggerFactory.getLogger(WorkerApplication.class);

    public static void main(String[] args) {
        SpringApplication.run(WorkerApplication.class, args);
    }

    @Scheduled(fixedDelay = 60_000, initialDelay = 5_000)
    public void heartbeat() {
        log.info("pipewise-worker heartbeat");
    }
}
