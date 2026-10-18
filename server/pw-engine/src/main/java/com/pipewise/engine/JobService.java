package com.pipewise.engine;

import com.pipewise.engine.EngineRepository.JobRow;
import org.springframework.stereotype.Service;

import java.util.List;

@Service
public class JobService {

    private final EngineRepository repository;

    public JobService(EngineRepository repository) {
        this.repository = repository;
    }

    public List<JobRow> claim(String workerId, int limit) {
        return repository.claimJobs(workerId, limit);
    }

    public void done(long jobId) {
        repository.markJobDone(jobId);
    }

    public void failed(long jobId, Exception error) {
        String message = error.getClass().getSimpleName() + ": " + error.getMessage();
        repository.markJobFailed(jobId, message);
    }

    public int requeueExpired() {
        return repository.requeueExpired();
    }
}
