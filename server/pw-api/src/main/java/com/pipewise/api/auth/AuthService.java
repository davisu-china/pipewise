package com.pipewise.api.auth;

import com.pipewise.api.config.PipeWiseProperties;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;

@Service
public class AuthService {

    public static final String COOKIE_NAME = "PW_SESSION";
    private static final String KEY_PREFIX = "pw:auth:session:";

    private final StringRedisTemplate redis;
    private final PipeWiseProperties properties;

    public AuthService(StringRedisTemplate redis, PipeWiseProperties properties) {
        this.redis = redis;
        this.properties = properties;
    }

    public boolean validCredentials(String username, String password) {
        return Objects.equals(properties.getAuth().getUsername(), username)
                && Objects.equals(properties.getAuth().getPassword(), password);
    }

    public String createSession(String username) {
        String token = UUID.randomUUID().toString().replace("-", "")
                + UUID.randomUUID().toString().replace("-", "");
        redis.opsForValue().set(KEY_PREFIX + token, username, ttl());
        return token;
    }

    public Optional<String> findUser(String token) {
        if (token == null || token.isBlank()) {
            return Optional.empty();
        }
        String username = redis.opsForValue().get(KEY_PREFIX + token);
        return username == null || username.isBlank() ? Optional.empty() : Optional.of(username);
    }

    public void deleteSession(String token) {
        if (token != null && !token.isBlank()) {
            redis.delete(KEY_PREFIX + token);
        }
    }

    public Duration ttl() {
        int days = Math.max(1, properties.getAuth().getSessionTtlDays());
        return Duration.ofDays(days);
    }

    public long ttlSeconds() {
        return ttl().toSeconds();
    }
}
