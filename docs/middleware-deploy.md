# PipeWise 单机中间件部署与调用说明

> 组件：PostgreSQL 16 / Redis 7 / MinIO / RocketMQ 5.3.1（单机，Docker Compose）
> 主机：`111.228.14.136`
> 部署日期：2026-10-18
>
> **本文件不含密码。** 完整凭据在部署机 `/opt/pipewise-infra/credentials.txt`（root 600），
> 或在部署机执行 `sudo deploy/deploy.sh show` 查看。含密码的完整版部署手册由项目负责人私发。

## 1. 部署概览

| 组件 | 容器 | 镜像 | 端口 | 数据卷 |
|---|---|---|---|---|
| PostgreSQL 16 | `pipewise-postgres` | `postgres:16-alpine` | `5434 → 5432` | `pipewise-infra_pgdata` |
| Redis 7 | `pipewise-redis` | `redis:7-alpine` | `6380 → 6379` | `pipewise-infra_redisdata` |
| MinIO | `pipewise-minio` | `minio/minio:latest` | `9010` API / `9011` Console | `pipewise-infra_miniodata` |
| RocketMQ Namesrv | `pipewise-rocketmq-namesrv` | `apache/rocketmq:5.3.1` | `9876` | `pipewise-infra_namesrvlogs` |
| RocketMQ Broker | `pipewise-rocketmq-broker` | `apache/rocketmq:5.3.1` | `10911` / `10909` | `pipewise-infra_brokerstore`、`_brokerlogs` |

部署目录 `/opt/pipewise-infra/`：`docker-compose.yml`、`.env`、`credentials.txt`、
`rocketmq/broker.conf`、`rocketmq/plain_acl.yml`。

## 2. 网络与安全组（重要）

本机防火墙已放行（iptables INPUT ACCEPT、firewalld 关闭、SELinux 关闭），服务监听 `0.0.0.0`。
2026-10-18 从多个外部节点复测：**5434 / 6380 / 9010 / 9011 / 9876 / 10911 / 10909 均可握手成功**
（9010/9011 各有一个探测节点无响应，属探测节点问题）。学员可从外部直连。

入站 TCP 端口（已配置）：

```text
5434   PostgreSQL
6380   Redis
9010   MinIO S3 API
9011   MinIO Console（可选）
9876   RocketMQ Nameserver
10911  RocketMQ Broker
10909  RocketMQ VIP 通道
```

控制台路径通常为：京东云控制台 → 云主机 → 安全组 → 入站规则 → 添加规则。
建议来源限制为学员出口 IP 段，而不是 `0.0.0.0/0`。

外部连通性验证：

```bash
nc -vz 111.228.14.136 5434
nc -vz 111.228.14.136 6380
nc -vz 111.228.14.136 9010
nc -vz 111.228.14.136 9876
nc -vz 111.228.14.136 10911
```

临时替代（需要服务器 SSH 账号）：

```bash
ssh -N -L 5434:127.0.0.1:5434 -L 6380:127.0.0.1:6380 \
  -L 9010:127.0.0.1:9010 -L 9011:127.0.0.1:9011 \
  -L 9876:127.0.0.1:9876 -L 10911:127.0.0.1:10911 \
  -L 10909:127.0.0.1:10909 <user>@111.228.14.136
```

之后把地址换成 `127.0.0.1` 即可。

## 3. 获取凭据

在部署机：

```bash
sudo /home/metabot/metabot-workspace/pipewise/deploy/deploy.sh show
```

或读取 `/opt/pipewise-infra/credentials.txt`（root 600）。凭据包含：

| 服务 | 地址 | 账号 / Access Key | 密码 / Secret Key | 数据库 / 桶 |
|---|---|---|---|---|
| PostgreSQL 16 | `111.228.14.136:5434` | `pipewise` | `<PG_PASSWORD>` | 数据库 `pipewise` |
| Redis 7 | `111.228.14.136:6380` | 默认用户 | `<REDIS_PASSWORD>` | db 0–15（AOF） |
| MinIO | `http://111.228.14.136:9010`（Console `:9011`） | `pipewise` | `<MINIO_SECRET_KEY>` | 桶 `pipewise`、`student` |
| RocketMQ 5.3.1 | `111.228.14.136:9876`（Broker `:10911`） | `pipewise` | `<ROCKETMQ_SECRET_KEY>` | ACL；Topic/Group 自动创建 |

### Java 依赖清单（Maven）

| 用途 | Maven 坐标 | 版本 |
|---|---|---|
| PostgreSQL JDBC | `org.postgresql:postgresql` | 42.7.4 |
| HikariCP 连接池 | `com.zaxxer:HikariCP` | 5.1.0 |
| Redis（Jedis） | `redis.clients:jedis` | 5.1.3 |
| Redis（Lettuce） | `io.lettuce:lettuce-core` | 6.3.2.RELEASE |
| Spring Boot Redis | `org.springframework.boot:spring-boot-starter-data-redis` | 跟随 Spring Boot |
| MinIO SDK | `io.minio:minio` | 8.5.12 |
| RocketMQ 客户端 | `org.apache.rocketmq:rocketmq-client` | 5.3.1 |
| RocketMQ ACL | `org.apache.rocketmq:rocketmq-acl` | 5.3.1 |

Java 8+ 均可；Spring Boot 3 需要 Java 17+。

## 4. PostgreSQL

```text
jdbc:postgresql://111.228.14.136:5434/pipewise
postgresql://pipewise:<PG_PASSWORD>@111.228.14.136:5434/pipewise
```

```bash
psql -h 111.228.14.136 -p 5434 -U pipewise -d pipewise
```

Python：

```python
from sqlalchemy import create_engine, text
engine = create_engine(
    "postgresql+psycopg://pipewise:<PG_PASSWORD>@111.228.14.136:5434/pipewise")
with engine.connect() as conn:
    print(conn.execute(text("select version()")).scalar())
```

Java（JDBC）：

```java
String url = "jdbc:postgresql://111.228.14.136:5434/pipewise?sslmode=disable";
try (Connection conn = DriverManager.getConnection(
        url, "pipewise", "<PG_PASSWORD>");
     PreparedStatement ps = conn.prepareStatement("select version()");
     ResultSet rs = ps.executeQuery()) {
    if (rs.next()) System.out.println(rs.getString(1));
}
```

Java（HikariCP 连接池）：

```java
HikariConfig cfg = new HikariConfig();
cfg.setJdbcUrl("jdbc:postgresql://111.228.14.136:5434/pipewise?sslmode=disable");
cfg.setUsername("pipewise");
cfg.setPassword("<PG_PASSWORD>");
cfg.setMaximumPoolSize(10);
cfg.setConnectionTimeout(3000);

try (HikariDataSource ds = new HikariDataSource(cfg);
     Connection conn = ds.getConnection();
     PreparedStatement ps = conn.prepareStatement("select now()");
     ResultSet rs = ps.executeQuery()) {
    if (rs.next()) System.out.println(rs.getTimestamp(1));
}
```

Spring Boot：

```yaml
spring:
  datasource:
    url: jdbc:postgresql://111.228.14.136:5434/pipewise?sslmode=disable
    username: pipewise
    password: <PG_PASSWORD>
    hikari:
      maximum-pool-size: 10
      connection-timeout: 3000
```


说明：数据库 owner 为 `pipewise`；最大连接 200，`shared_buffers=256MB`；
未启用 TLS，仅用于教学与测试数据。

## 5. Redis

```text
redis://:<REDIS_PASSWORD>@111.228.14.136:6380/0
```

```bash
redis-cli -h 111.228.14.136 -p 6380 -a <REDIS_PASSWORD> ping
```

Python：

```python
import redis
r = redis.Redis(host="111.228.14.136", port=6380,
                password="<REDIS_PASSWORD>", decode_responses=True)
r.set("demo:key", "hello")
```

Java（Jedis）：

```java
JedisPooled jedis = new JedisPooled(
    URI.create("redis://:<REDIS_PASSWORD>@111.228.14.136:6380/0"));
jedis.set("demo:key", "hello");
System.out.println(jedis.get("demo:key"));
jedis.close();
```

Java（Lettuce）：

```java
RedisClient client = RedisClient.create(
    "redis://:<REDIS_PASSWORD>@111.228.14.136:6380/0");
try (StatefulRedisConnection<String, String> conn = client.connect()) {
    RedisCommands<String, String> cmd = conn.sync();
    cmd.set("demo:key", "hello");
    System.out.println(cmd.get("demo:key"));
}
client.shutdown();
```

Spring Boot：

```yaml
spring:
  data:
    redis:
      host: 111.228.14.136
      port: 6380
      password: <REDIS_PASSWORD>
      database: 0
      timeout: 3s
```


说明：已开启 AOF；`protected-mode no` + 密码；有 16 个逻辑库，建议用 key 前缀隔离。

## 6. MinIO

```text
S3 Endpoint : http://111.228.14.136:9010
Console     : http://111.228.14.136:9011
Access Key  : pipewise
Secret Key  : <MINIO_SECRET_KEY>
Buckets     : pipewise（应用）、student（学员练习）
```

```bash
mc alias set pipewise http://111.228.14.136:9010 pipewise <MINIO_SECRET_KEY>
mc ls pipewise
```

Python（boto3）：

```python
import boto3
s3 = boto3.client(
    "s3",
    endpoint_url="http://111.228.14.136:9010",
    aws_access_key_id="pipewise",
    aws_secret_access_key="<MINIO_SECRET_KEY>",
    region_name="us-east-1",
    config=boto3.session.Config(signature_version="s3v4"),
)
s3.put_object(Bucket="student", Key="demo.txt", Body=b"hello")
```

Java（MinIO SDK）：

```java
MinioClient client = MinioClient.builder()
    .endpoint("http://111.228.14.136:9010")
    .credentials("pipewise", "<MINIO_SECRET_KEY>")
    .build();

String bucket = "student";
if (!client.bucketExists(BucketExistsArgs.builder().bucket(bucket).build())) {
    client.makeBucket(MakeBucketArgs.builder().bucket(bucket).build());
}

client.putObject(PutObjectArgs.builder()
    .bucket(bucket).object("demo/hello.txt")
    .stream(new ByteArrayInputStream(
        "hello minio".getBytes(StandardCharsets.UTF_8)),
        -1, 10 * 1024 * 1024)
    .contentType("text/plain")
    .build());

try (InputStream in = client.getObject(GetObjectArgs.builder()
        .bucket(bucket).object("demo/hello.txt").build())) {
    System.out.println(new String(in.readAllBytes(), StandardCharsets.UTF_8));
}

String url = client.getPresignedObjectUrl(GetPresignedObjectUrlArgs.builder()
    .method(Method.GET).bucket(bucket).object("demo/hello.txt")
    .expiry(7, TimeUnit.DAYS).build());
System.out.println(url);
```


当前为 HTTP，预签名 URL 的外部可访问性取决于安全组是否放行 9010。

## 7. RocketMQ

```text
Nameserver : 111.228.14.136:9876
Broker     : 111.228.14.136:10911（由 nameserver 自动发现）
ACL        : accessKey=pipewise, secretKey=<ROCKETMQ_SECRET_KEY>
Topic/Group: 自动创建；建议 student_<name>_topic / student_<name>_group
```

Java 生产者（依赖 `rocketmq-client` 与 `rocketmq-acl` 5.3.1）：

```java
DefaultMQProducer producer = new DefaultMQProducer(
    "student_demo_producer",
    new AclClientRPCHook(new SessionCredentials(
        "pipewise", "<ROCKETMQ_SECRET_KEY>")));
producer.setNamesrvAddr("111.228.14.136:9876");
producer.start();
SendResult r = producer.send(new Message(
    "student_demo_topic", "hello".getBytes(StandardCharsets.UTF_8)));
System.out.println(r.getSendStatus() + " " + r.getMsgId());
producer.shutdown();
```

Java 消费者：

```java
DefaultMQPushConsumer consumer = new DefaultMQPushConsumer(
    "student_demo_consumer",
    new AclClientRPCHook(new SessionCredentials(
        "pipewise", "<ROCKETMQ_SECRET_KEY>")));
consumer.setNamesrvAddr("111.228.14.136:9876");
consumer.subscribe("student_demo_topic", "*");
consumer.registerMessageListener((MessageListenerConcurrently) (msgs, ctx) -> {
    for (MessageExt m : msgs) {
        System.out.println(new String(m.getBody(), StandardCharsets.UTF_8));
    }
    return ConsumeConcurrentlyStatus.CONSUME_SUCCESS;
});
consumer.start();
```

生产者/消费者都是线程安全的，建议应用内单例复用；若只放行了 10911 而 10909 未放行，
可调用 `producer.setVipChannelEnabled(false)` / `consumer.setVipChannelEnabled(false)`。
本环境 10909 已放行，无需关闭。

Python（`rocketmq-client-python` 2.0.0）：

```python
from rocketmq.client import Producer, Message

p = Producer("student_demo_producer")
p.set_name_server_address("111.228.14.136:9876")
p.set_session_credentials("pipewise", "<ROCKETMQ_SECRET_KEY>", "LOCAL")
p.start()

msg = Message("student_demo_topic")
msg.set_body("hello rocketmq")
print(p.send_sync(msg))
p.shutdown()
```

说明：ACL 已启用并验证（无凭据拒绝、带凭据 `SEND_OK`）；单机异步刷盘，适合教学。

## 8. 运维

```bash
cd /opt/pipewise-infra

docker compose ps
docker compose logs -f postgres
docker compose restart redis
docker compose stop
docker compose up -d
docker compose down        # 不删 named volume
```

备份：

```bash
# PostgreSQL
docker exec pipewise-postgres pg_dump -U pipewise -d pipewise > backup-$(date +%F).sql

# Redis
docker exec pipewise-redis redis-cli -a <REDIS_PASSWORD> BGSAVE

# MinIO
mc mirror pipewise/student /opt/pipewise-infra/backup-minio/student

# RocketMQ：停 broker 后打包 store 卷
docker run --rm -v pipewise-infra_brokerstore:/data -v /opt/pipewise-infra:/backup alpine \
  tar czf /backup/rocketmq-store-$(date +%F).tgz -C /data .
```

## 9. 故障排查

| 现象 | 原因 | 处理 |
|---|---|---|
| 外部连接超时，本机正常 | 安全组未放行 | 按第 2 节添加规则 |
| 服务器上用公网 IP 连自己超时 | NAT 不支持 hairpin | 服务器本机用 `127.0.0.1` |
| RocketMQ broker 反复重启 | 数据卷属主不是 uid 3000 | 部署脚本已自动 chown；手动见下 |
| Docker Hub 拉镜像超时 | 网络抖动 | 重跑部署脚本（已有镜像会跳过） |
| Redis `NOAUTH` | 未带密码 | 使用 `-a` 或连接串密码 |
| RocketMQ 发送超时但端口通 | 未配置 ACL | 客户端加 `AclClientRPCHook` / `set_session_credentials` |

```bash
# 修复 RocketMQ 卷权限
docker run --rm --user root \
  -v pipewise-infra_brokerstore:/store \
  -v pipewise-infra_brokerlogs:/logs \
  -v pipewise-infra_namesrvlogs:/nlogs \
  apache/rocketmq:5.3.1 \
  sh -c 'chown -R 3000:3000 /store /logs /nlogs'
docker compose restart rocketmq-namesrv rocketmq-broker
```

## 10. 安全约定

- 四个组件均为明文协议（无 TLS），只放教学/测试数据，不放真实个人信息或密钥。
- 安全组尽量限制来源 IP；课程结束及时收回。
- 学员练习使用 `student` 桶、独立 schema / key 前缀，避免误删应用数据。
- 密码泄露或课程结束：修改 `/opt/pipewise-infra/.env` 后重跑部署脚本轮换。
- 含密码的完整部署手册仅私发，不要提交到公开仓库。

## 11. 部署脚本

```bash
sudo /home/metabot/metabot-workspace/pipewise/deploy/deploy.sh          # 部署/更新
sudo /home/metabot/metabot-workspace/pipewise/deploy/deploy.sh status   # 健康检查
sudo /home/metabot/metabot-workspace/pipewise/deploy/deploy.sh show     # 查看凭据
sudo /home/metabot/metabot-workspace/pipewise/deploy/deploy.sh net      # 防火墙/NAT
```
