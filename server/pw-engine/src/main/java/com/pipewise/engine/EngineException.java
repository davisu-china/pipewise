package com.pipewise.engine;

public class EngineException extends RuntimeException {

    private final int status;
    private final String code;

    public EngineException(int status, String code, String message) {
        super(message);
        this.status = status;
        this.code = code;
    }

    public int status() {
        return status;
    }

    public String code() {
        return code;
    }

    public static EngineException notFound(String message) {
        return new EngineException(404, "NOT_FOUND", message);
    }

    public static EngineException conflict(String code, String message) {
        return new EngineException(409, code, message);
    }

    public static EngineException badRequest(String code, String message) {
        return new EngineException(400, code, message);
    }

    public static EngineException forbidden(String code, String message) {
        return new EngineException(403, code, message);
    }
}
