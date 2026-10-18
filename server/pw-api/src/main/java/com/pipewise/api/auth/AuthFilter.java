package com.pipewise.api.auth;

import com.fasterxml.jackson.databind.ObjectMapper;
import com.pipewise.api.web.TraceIdFilter;
import com.pipewise.common.api.ApiResponse;
import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.Cookie;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.Set;

@Component
@Order(10)
public class AuthFilter extends OncePerRequestFilter {

    private static final Set<String> PUBLIC_PATHS = Set.of(
            "/api/v1/auth/login",
            "/api/v1/auth/logout",
            "/api/v1/ping",
            "/api/v1/infra/health");

    private final AuthService authService;
    private final ObjectMapper objectMapper;

    public AuthFilter(AuthService authService, ObjectMapper objectMapper) {
        this.authService = authService;
        this.objectMapper = objectMapper;
    }

    @Override
    protected void doFilterInternal(HttpServletRequest request,
                                    HttpServletResponse response,
                                    FilterChain filterChain) throws ServletException, IOException {
        String path = request.getRequestURI();
        if (!path.startsWith("/api/")
                || PUBLIC_PATHS.contains(path)
                || "OPTIONS".equalsIgnoreCase(request.getMethod())) {
            filterChain.doFilter(request, response);
            return;
        }

        String token = readToken(request);
        var user = authService.findUser(token);
        if (user.isEmpty()) {
            response.setStatus(HttpServletResponse.SC_UNAUTHORIZED);
            response.setContentType("application/json;charset=UTF-8");
            objectMapper.writeValue(response.getWriter(),
                    ApiResponse.fail("UNAUTHORIZED", "请先登录", MDC.get(TraceIdFilter.TRACE_ID)));
            return;
        }
        request.setAttribute("pw.user", user.get());
        filterChain.doFilter(request, response);
    }

    private String readToken(HttpServletRequest request) {
        Cookie[] cookies = request.getCookies();
        if (cookies == null) {
            return null;
        }
        for (Cookie cookie : cookies) {
            if (AuthService.COOKIE_NAME.equals(cookie.getName())) {
                return cookie.getValue();
            }
        }
        return null;
    }
}
