package com.pipewise.common.api;

/**
 * 所有 API 的统一响应包。traceId 由 TraceIdFilter 写入，便于串联日志。
 */
public record ApiResponse<T>(boolean success, T data, ApiError error, String traceId) {

    public static <T> ApiResponse<T> ok(T data, String traceId) {
        return new ApiResponse<>(true, data, null, traceId);
    }

    public static <T> ApiResponse<T> fail(String code, String message, String traceId) {
        return new ApiResponse<>(false, null, new ApiError(code, message), traceId);
    }
}
