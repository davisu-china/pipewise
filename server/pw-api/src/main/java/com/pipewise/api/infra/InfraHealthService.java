package com.pipewise.api.infra;

import com.pipewise.api.config.PipeWiseProperties;
import io.minio.MinioClient;
import org.springframework.data.redis.connection.RedisConnection;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.stereotype.Service;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * P0 环境自检：只验证连通性与认证，不写入业务数据。
 */
@Service
public class InfraHealthService {

    private final JdbcTemplate jdbcTemplate;
    private final StringRedisTemplate redisTemplate;
    private final PipeWiseProperties properties;
    private final RocketMqProbe rocketMqProbe;

    public InfraHealthService(JdbcTemplate jdbcTemplate,
                              StringRedisTemplate redisTemplate,
                              PipeWiseProperties properties,
                              RocketMqProbe rocketMqProbe) {
        this.jdbcTemplate = jdbcTemplate;
        this.redisTemplate = redisTemplate;
        this.properties = properties;
        this.rocketMqProbe = rocketMqProbe;
    }

    public Map<String, Object> check() {
        Map<String, Object> result = new LinkedHashMap<>();
        result.put("postgres", checkPostgres());
        result.put("redis", checkRedis());
        result.put("minio", checkMinio());
        result.put("rocketmq", rocketMqProbe.check());
        return result;
    }

    private Map<String, Object> checkPostgres() {
        try {
            Integer value = jdbcTemplate.queryForObject("select 1", Integer.class);
            return status("UP", "select 1 -> " + value);
        } catch (Exception ex) {
            return status("DOWN", safeMessage(ex));
        }
    }

    private Map<String, Object> checkRedis() {
        try (RedisConnection connection = redisTemplate.getConnectionFactory().getConnection()) {
            String pong = connection.ping();
            return status("UP", "PING -> " + pong);
        } catch (Exception ex) {
            return status("DOWN", safeMessage(ex));
        }
    }

    private Map<String, Object> checkMinio() {
        PipeWiseProperties.Minio minio = properties.getMinio();
        if (isBlank(minio.getAccessKey())) {
            return status("SKIPPED", "PW_MINIO_ACCESS_KEY 未配置");
        }
        try {
            MinioClient client = MinioClient.builder()
                    .endpoint(minio.getEndpoint())
                    .credentials(minio.getAccessKey(), minio.getSecretKey())
                    .build();
            int buckets = client.listBuckets().size();
            return status("UP", "buckets=" + buckets);
        } catch (Exception ex) {
            return status("DOWN", safeMessage(ex));
        }
    }

    private Map<String, Object> status(String status, String detail) {
        Map<String, Object> item = new LinkedHashMap<>();
        item.put("status", status);
        item.put("detail", detail);
        return item;
    }

    private boolean isBlank(String value) {
        return value == null || value.isBlank();
    }

    private String safeMessage(Exception ex) {
        String message = ex.getMessage();
        return message == null || message.isBlank() ? ex.getClass().getSimpleName() : message;
    }
}
