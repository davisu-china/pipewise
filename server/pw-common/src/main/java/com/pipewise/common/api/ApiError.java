package com.pipewise.common.api;

/**
 * 统一错误体。code 是稳定的机器可读标识，message 面向调用方。
 */
public record ApiError(String code, String message) {
}
