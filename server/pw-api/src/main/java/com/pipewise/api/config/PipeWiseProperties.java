package com.pipewise.api.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

/**
 * PipeWise 自有配置。凭证一律从环境变量注入，禁止写进仓库。
 */
@ConfigurationProperties(prefix = "pw")
public class PipeWiseProperties {

    private final Minio minio = new Minio();
    private final Rocketmq rocketmq = new Rocketmq();
    private final Auth auth = new Auth();

    public Minio getMinio() {
        return minio;
    }

    public Rocketmq getRocketmq() {
        return rocketmq;
    }

    public Auth getAuth() {
        return auth;
    }

    public static class Auth {
        private String username = "pipewise";
        private String password = "pipewise";
        private int sessionTtlDays = 7;

        public String getUsername() {
            return username;
        }

        public void setUsername(String username) {
            this.username = username;
        }

        public String getPassword() {
            return password;
        }

        public void setPassword(String password) {
            this.password = password;
        }

        public int getSessionTtlDays() {
            return sessionTtlDays;
        }

        public void setSessionTtlDays(int sessionTtlDays) {
            this.sessionTtlDays = sessionTtlDays;
        }
    }

    public static class Minio {
        private String endpoint = "http://127.0.0.1:9010";
        private String accessKey = "";
        private String secretKey = "";
        private String bucket = "pipewise";

        public String getEndpoint() {
            return endpoint;
        }

        public void setEndpoint(String endpoint) {
            this.endpoint = endpoint;
        }

        public String getAccessKey() {
            return accessKey;
        }

        public void setAccessKey(String accessKey) {
            this.accessKey = accessKey;
        }

        public String getSecretKey() {
            return secretKey;
        }

        public void setSecretKey(String secretKey) {
            this.secretKey = secretKey;
        }

        public String getBucket() {
            return bucket;
        }

        public void setBucket(String bucket) {
            this.bucket = bucket;
        }
    }

    public static class Rocketmq {
        private String namesrv = "127.0.0.1:9876";
        private String accessKey = "";
        private String secretKey = "";
        private String topic = "pipewise_health_check";

        public String getNamesrv() {
            return namesrv;
        }

        public void setNamesrv(String namesrv) {
            this.namesrv = namesrv;
        }

        public String getAccessKey() {
            return accessKey;
        }

        public void setAccessKey(String accessKey) {
            this.accessKey = accessKey;
        }

        public String getSecretKey() {
            return secretKey;
        }

        public void setSecretKey(String secretKey) {
            this.secretKey = secretKey;
        }

        public String getTopic() {
            return topic;
        }

        public void setTopic(String topic) {
            this.topic = topic;
        }
    }
}
