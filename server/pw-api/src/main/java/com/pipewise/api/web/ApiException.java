package com.pipewise.api.web;

/**
 * 业务异常：带 HTTP 状态与稳定错误码，由 GlobalExceptionHandler 统一转换。
 */
public class ApiException extends RuntimeException {

    private final int status;
    private final String code;

    public ApiException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public int getStatus() {
        return status;
    }

    public String getCode() {
        return code;
    }

    public static ApiException notFound(String message) {
        return new ApiException(404, "NOT_FOUND", message);
    }

    public static ApiException conflict(String code, String message) {
        return new ApiException(409, code, message);
    }

    public static ApiException badRequest(String code, String message) {
        return new ApiException(400, code, message);
    }
}
