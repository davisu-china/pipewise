"""统一的业务错误。

API 层把 `ApiError` 翻成 `{error:{code,message,details}}`；引擎内部抛出的普通异常
一律视为 500（不把内部细节漏给客户端）。
"""


class ApiError(Exception):
    def __init__(self, status: int, code: str, message: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message
        self.details = details or {}


def not_found(what: str) -> ApiError:
    return ApiError(404, "NOT_FOUND", f"{what}不存在")


def forbidden(msg: str = "没有权限") -> ApiError:
    return ApiError(403, "FORBIDDEN", msg)


def conflict(code: str, msg: str, details: dict | None = None) -> ApiError:
    return ApiError(409, code, msg, details)


def bad_request(code: str, msg: str, details: dict | None = None) -> ApiError:
    return ApiError(400, code, msg, details)


class VariableConflict(Exception):
    def __init__(self, name: str, expected: int, actual: int) -> None:
        super().__init__(f"变量 {name} 版本冲突（期望 {expected}，实际 {actual}）")
        self.name = name
        self.expected = expected
        self.actual = actual
