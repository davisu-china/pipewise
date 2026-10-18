package com.pipewise.api.auth;

import com.pipewise.api.web.TraceIdFilter;
import com.pipewise.common.api.ApiResponse;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.slf4j.MDC;
import org.springframework.http.HttpHeaders;
import org.springframework.http.ResponseCookie;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.CookieValue;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestAttribute;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.time.Duration;
import java.util.Map;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService authService;

    public AuthController(AuthService authService) {
        this.authService = authService;
    }

    public record LoginRequest(@NotBlank String username, @NotBlank String password) {
    }

    @PostMapping("/login")
    public ResponseEntity<ApiResponse<Map<String, Object>>> login(
            @Valid @RequestBody LoginRequest request,
            HttpServletRequest servletRequest) {
        if (!authService.validCredentials(request.username(), request.password())) {
            return ResponseEntity.status(401)
                    .body(ApiResponse.fail("INVALID_CREDENTIALS", "用户名或密码错误", traceId()));
        }
        String token = authService.createSession(request.username());
        ResponseCookie cookie = cookie(token, authService.ttl(), servletRequest.isSecure());
        return ResponseEntity.ok()
                .header(HttpHeaders.SET_COOKIE, cookie.toString())
                .body(ApiResponse.ok(Map.of("username", request.username()), traceId()));
    }

    @GetMapping("/me")
    public ApiResponse<Map<String, Object>> me(@RequestAttribute("pw.user") String user) {
        return ApiResponse.ok(Map.of("username", user), traceId());
    }

    @PostMapping("/logout")
    public ResponseEntity<ApiResponse<Map<String, Object>>> logout(
            @CookieValue(name = AuthService.COOKIE_NAME, required = false) String token,
            HttpServletRequest servletRequest) {
        authService.deleteSession(token);
        ResponseCookie cookie = cookie("", Duration.ZERO, servletRequest.isSecure());
        return ResponseEntity.ok()
                .header(HttpHeaders.SET_COOKIE, cookie.toString())
                .body(ApiResponse.ok(Map.of("status", "logged_out"), traceId()));
    }

    private ResponseCookie cookie(String value, Duration maxAge, boolean secure) {
        return ResponseCookie.from(AuthService.COOKIE_NAME, value)
                .httpOnly(true)
                .secure(secure)
                .sameSite("Lax")
                .path("/")
                .maxAge(maxAge)
                .build();
    }

    private String traceId() {
        return MDC.get(TraceIdFilter.TRACE_ID);
    }
}
