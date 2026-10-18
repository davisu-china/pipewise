package com.pipewise.worker;

import com.pipewise.engine.EngineProcessor;
import com.pipewise.engine.EngineRepository.JobRow;
import com.pipewise.engine.JobService;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.scheduling.annotation.Scheduled;
import org.springframework.stereotype.Component;

import java.util.List;
import java.util.UUID;

@Component
public class EngineWorker {

    private static final Logger log = LoggerFactory.getLogger(EngineWorker.class);

    private final JobService jobs;
    private final EngineProcessor processor;
    private final String workerId = "worker-" + UUID.randomUUID().toString().substring(0, 8);

    public EngineWorker(JobService jobs, EngineProcessor processor) {
        this.jobs = jobs;
        this.processor = processor;
    }

    @Scheduled(fixedDelay = 300, initialDelay = 1000)
    public void tick() {
        List<JobRow> batch = jobs.claim(workerId, 16);
        for (JobRow job : batch) {
            try {
                processor.process(job);
                jobs.done(job.id());
            } catch (Exception ex) {
                log.error("job {} failed: {}", job.id(), ex.getMessage(), ex);
                jobs.failed(job.id(), ex);
            }
        }
    }

    @Scheduled(fixedDelay = 10_000, initialDelay = 10_000)
    public void requeueExpired() {
        int count = jobs.requeueExpired();
        if (count > 0) {
            log.warn("requeued {} expired jobs", count);
        }
    }
}
