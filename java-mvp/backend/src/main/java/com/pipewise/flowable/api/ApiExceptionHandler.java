package com.pipewise.flowable.api;

import org.flowable.common.engine.api.FlowableException;
import org.flowable.common.engine.api.FlowableObjectNotFoundException;
import org.flowable.common.engine.api.FlowableOptimisticLockingException;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

@RestControllerAdvice
public class ApiExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(ApiException.class)
    public ResponseEntity<Dtos.ErrorEnvelope> handleApi(ApiException e) {
        return ResponseEntity.status(e.status())
                .body(new Dtos.ErrorEnvelope(new Dtos.ErrorDto(e.code(), e.getMessage())));
    }

    @ExceptionHandler(FlowableObjectNotFoundException.class)
    public ResponseEntity<Dtos.ErrorEnvelope> handleNotFound(FlowableObjectNotFoundException e) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND)
                .body(new Dtos.ErrorEnvelope(new Dtos.ErrorDto("NOT_FOUND", e.getMessage())));
    }

    @ExceptionHandler(FlowableOptimisticLockingException.class)
    public ResponseEntity<Dtos.ErrorEnvelope> handleOptimisticLock(FlowableOptimisticLockingException e) {
        // 并发完成同一任务/同一执行时 Flowable 会抛乐观锁异常；API 层转成 409 让客户端重试或刷新。
        return ResponseEntity.status(HttpStatus.CONFLICT)
                .body(new Dtos.ErrorEnvelope(new Dtos.ErrorDto("CONCURRENT_UPDATE", "任务已被其他人处理，请刷新后重试")));
    }

    @ExceptionHandler(FlowableException.class)
    public ResponseEntity<Dtos.ErrorEnvelope> handleFlowable(FlowableException e) {
        log.warn("flowable error", e);
        return ResponseEntity.status(HttpStatus.BAD_REQUEST)
                .body(new Dtos.ErrorEnvelope(new Dtos.ErrorDto("FLOWABLE_ERROR", e.getMessage())));
    }

    @ExceptionHandler(Exception.class)
    public ResponseEntity<Dtos.ErrorEnvelope> handleOther(Exception e) {
        log.error("unexpected error", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR)
                .body(new Dtos.ErrorEnvelope(new Dtos.ErrorDto("INTERNAL_ERROR", "服务器内部错误")));
    }
}
