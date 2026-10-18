#!/bin/bash
# PipeWise 单机中间件部署脚本
# 依赖：Docker 26 + Docker Compose v2；该脚本通过 sudoers 免密以 root 运行。
# 部署：PostgreSQL 16 / Redis 7 / MinIO / RocketMQ 5.3.1（均为单机）
set -euo pipefail

BASE=/opt/pipewise-infra
PUBLIC_IP=111.228.14.136
ENV_FILE="$BASE/.env"

if [ "${1:-}" = "show" ]; then
  cat "$BASE/credentials.txt"
  exit 0
fi

if [ "${1:-}" = "appauth" ]; then
  cat /opt/pipewise/access.txt
  exit 0
fi

if [ "${1:-}" = "brokerlog" ]; then
  docker logs pipewise-rocketmq-broker 2>&1 | tail -"${2:-200}"
  exit 0
fi

if [ "${1:-}" = "webstatus" ]; then
  echo "=== nginx processes ==="; ps aux | grep -E '[n]ginx' | head -10
  echo "=== docker nginx ==="; docker ps --format '{{.Names}} {{.Image}} {{.Ports}}' 2>&1 | grep -i nginx | head -10
  echo "=== systemd pipewise ==="; systemctl list-units --type=service --no-pager 2>/dev/null | grep -Ei 'pipewise|nginx' | head -10
  systemctl status pipewise-api --no-pager 2>&1 | head -12
  echo "=== dirs ==="; ls -la /opt/pipewise /opt/jianjian/deploy/nginx 2>&1 | head -40
  echo "=== nginx config pipewise ==="; nginx -T 2>&1 | grep -nE 'pipewise|server_name|listen 443|location' | head -100
  echo "=== listening ==="; netstat -lntp 2>/dev/null | grep -E ':(80|443|8121|18081) ' | head -10
  exit 0
fi

if [ "${1:-}" = "rmqlib" ]; then
  rm -rf /tmp/rmq-lib
  docker cp pipewise-rocketmq-broker:/home/rocketmq/rocketmq-5.3.1/lib /tmp/rmq-lib
  chown -R metabot:metabot /tmp/rmq-lib
  echo "jars: $(ls /tmp/rmq-lib | wc -l)"
  ls /tmp/rmq-lib | grep -E 'acl|client|common|remoting' | head
  exit 0
fi

if [ "${1:-}" = "net" ]; then
  echo "=== filter ==="; iptables -S 2>&1
  echo "=== JDCLOUDHIDS_IN ==="; iptables -S JDCLOUDHIDS_IN 2>&1
  echo "=== JDCLOUDHIDS_IN_LIVE ==="; iptables -S JDCLOUDHIDS_IN_LIVE 2>&1
  echo "=== nat ==="; iptables -t nat -S 2>&1 | head -80
  echo "=== addrs ==="; hostname -I 2>&1; /sbin/ip -4 addr 2>&1 | grep -E 'inet ' | head -10
  exit 0
fi

if [ "${1:-}" = "brokerrun" ]; then
  echo "=== volume perms ==="
  docker run --rm --user root -v pipewise-infra_brokerlogs:/logs -v pipewise-infra_brokerstore:/store \
    apache/rocketmq:5.3.1 sh -c 'ls -ld /logs /store; ls -la /logs' 2>&1
  echo "=== broker foreground ==="
  docker run --rm --network pipewise-infra_default --user rocketmq \
    -e NAMESRV_ADDR=pipewise-rocketmq-namesrv:9876 \
    -v /opt/pipewise-infra/rocketmq/broker.conf:/home/rocketmq/rocketmq-5.3.1/conf/broker.conf:ro \
    -v /opt/pipewise-infra/rocketmq/plain_acl.yml:/home/rocketmq/rocketmq-5.3.1/conf/plain_acl.yml:ro \
    -v pipewise-infra_brokerstore:/home/rocketmq/store \
    -v pipewise-infra_brokerlogs:/home/rocketmq/logs \
    apache/rocketmq:5.3.1 \
    sh -c 'cd /home/rocketmq/rocketmq-5.3.1 && timeout 25 sh bin/mqbroker -c conf/broker.conf' 2>&1 | tail -100
  exit 0
fi

if [ "${1:-}" = "probe" ]; then
  docker inspect pipewise-rocketmq-broker -f 'user={{.Config.User}} entrypoint={{json .Config.Entrypoint}} cmd={{json .Config.Cmd}}' 2>&1
  docker run --rm --entrypoint /bin/sh apache/rocketmq:5.3.1 -c 'id; echo HOME=$HOME; ls -ld /home/rocketmq /home/rocketmq/logs /home/rocketmq/store 2>&1' 2>&1
  exit 0
fi

if [ "${1:-}" = "brokerfile" ]; then
  echo "=== container mounts ==="
  docker inspect pipewise-rocketmq-broker -f '{{json .Mounts}}' 2>&1
  echo
  VOL=$(docker volume inspect pipewise-infra_brokerlogs -f '{{.Mountpoint}}' 2>/dev/null)
  echo "=== volume: $VOL ==="
  find "$VOL" -maxdepth 3 -type f 2>&1 | head -20
  LOG=$(find "$VOL" -name 'broker.log' -type f 2>/dev/null | head -1)
  echo "=== broker.log: $LOG ==="
  [ -n "$LOG" ] && tail -"${2:-200}" "$LOG"
  exit 0
fi

mkdir -p "$BASE/rocketmq"

gen() { openssl rand -hex 12; }

# ---------- 1. 凭据（仅首次生成，后续复用） ----------
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<EOF
PG_PASSWORD=$(gen)
REDIS_PASSWORD=$(gen)
MINIO_USER=pipewise
MINIO_PASSWORD=$(gen)
ROCKETMQ_ACCESS_KEY=pipewise
ROCKETMQ_SECRET_KEY=$(gen)
PUBLIC_IP=$PUBLIC_IP
EOF
  chmod 600 "$ENV_FILE"
  echo "[init] generated credentials: $ENV_FILE"
fi
# shellcheck disable=SC1090
source "$ENV_FILE"

if [ "${1:-}" = "app" ]; then
  APP_DIR=/opt/pipewise
  WEB_ROOT=/opt/jianjian/deploy/nginx/html/pipewise
  NGINX_CONF=/opt/jianjian/deploy/nginx/nginx.conf
  API_JAR=/home/metabot/metabot-workspace/pipewise/server/pw-api/target/pw-api-0.1.0-SNAPSHOT.jar
  WORKER_JAR=/home/metabot/metabot-workspace/pipewise/server/pw-worker/target/pw-worker-0.1.0-SNAPSHOT.jar
  DIST=/home/metabot/metabot-workspace/pipewise/web/dist

  [ -f "$API_JAR" ] || { echo "missing $API_JAR"; exit 1; }
  [ -f "$WORKER_JAR" ] || { echo "missing $WORKER_JAR"; exit 1; }
  [ -f "$DIST/index.html" ] || { echo "missing $DIST/index.html"; exit 1; }

  mkdir -p "$APP_DIR"
  cat > "$APP_DIR/api.env" <<EOF
PW_API_PORT=18081
PW_PG_URL=jdbc:postgresql://111.228.14.136:5434/pipewise
PW_PG_USER=pipewise
PW_PG_PASSWORD=$PG_PASSWORD
PW_REDIS_HOST=111.228.14.136
PW_REDIS_PORT=6380
PW_REDIS_PASSWORD=$REDIS_PASSWORD
PW_MINIO_ENDPOINT=http://111.228.14.136:9010
PW_MINIO_ACCESS_KEY=$MINIO_USER
PW_MINIO_SECRET_KEY=$MINIO_PASSWORD
PW_MINIO_BUCKET=pipewise
PW_ROCKETMQ_NAMESRV=111.228.14.136:9876
PW_ROCKETMQ_ACCESS_KEY=$ROCKETMQ_ACCESS_KEY
PW_ROCKETMQ_SECRET_KEY=$ROCKETMQ_SECRET_KEY
PW_ROCKETMQ_TOPIC=pipewise_health_check
EOF
  chmod 600 "$APP_DIR/api.env"

  echo "[web] publishing dist -> $WEB_ROOT"
  rm -rf "$WEB_ROOT"
  mkdir -p "$WEB_ROOT"
  cp -a "$DIST"/. "$WEB_ROOT"/
  chmod -R a+rX "$WEB_ROOT"

  echo "[systemd] writing units"
  cat > /etc/systemd/system/pipewise-api.service <<EOF
[Unit]
Description=PipeWise API (Java P3)
After=network.target

[Service]
Type=simple
User=metabot
WorkingDirectory=/home/metabot/metabot-workspace/pipewise
EnvironmentFile=$APP_DIR/api.env
ExecStart=/home/metabot/.local/jdk21/bin/java -jar $API_JAR
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  cat > /etc/systemd/system/pipewise-worker.service <<EOF
[Unit]
Description=PipeWise Worker (Java P3)
After=network.target pipewise-api.service

[Service]
Type=simple
User=metabot
WorkingDirectory=/home/metabot/metabot-workspace/pipewise
EnvironmentFile=$APP_DIR/api.env
ExecStart=/home/metabot/.local/jdk21/bin/java -jar $WORKER_JAR
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF

  systemctl daemon-reload
  systemctl enable pipewise-api pipewise-worker >/dev/null 2>&1 || true
  systemctl restart pipewise-api pipewise-worker

  echo "[nginx] switching pipewise API 8121 -> 18081"
  BACKUP="$NGINX_CONF.bak.app.$(date +%Y%m%d-%H%M%S)"
  cp "$NGINX_CONF" "$BACKUP"
  python3 - "$NGINX_CONF" <<'PY'
import sys
path = sys.argv[1]
text = open(path, encoding='utf-8').read()
old = 'proxy_pass           http://172.17.0.1:8121/api/;'
new = 'proxy_pass           http://172.17.0.1:18081/api/;'
if old in text:
    text = text.replace(old, new)
elif new not in text:
    raise SystemExit('pipewise proxy_pass not found')
open(path, 'w', encoding='utf-8').write(text)
print('nginx config updated')
PY
  if ! docker exec jianjian-nginx nginx -t; then
    echo "[nginx] test failed, restoring backup"
    cp "$BACKUP" "$NGINX_CONF"
    docker exec jianjian-nginx nginx -t
    exit 1
  fi
  docker exec jianjian-nginx nginx -s reload

  sleep 4
  echo "=== services ==="
  systemctl --no-pager --lines=0 status pipewise-api pipewise-worker 2>&1 | grep -E 'pipewise|Active' | head -10
  echo "=== local API ==="
  curl -s -o /dev/null -w 'ping=%{http_code}\n' --max-time 5 http://127.0.0.1:18081/api/v1/ping || true
  echo "=== basic auth ==="
  cat "$APP_DIR/access.txt" 2>/dev/null || true
  echo "=== url ==="
  echo "https://jianjiange.site/pipewise/"
  exit 0
fi

if [ "${1:-}" = "status" ]; then
  cd "$BASE"
  echo "=== compose ps ==="
  docker compose ps
  echo "=== postgres ==="
  docker exec pipewise-postgres pg_isready -U pipewise -d pipewise
  echo "=== redis ==="
  docker exec pipewise-redis redis-cli -a "$REDIS_PASSWORD" ping 2>/dev/null
  echo "=== minio ==="
  curl -fsS http://127.0.0.1:9010/minio/health/live && echo
  echo "=== minio buckets ==="
  docker run --rm --network pipewise-infra_default \
    -e MC_HOST_pw="http://${MINIO_USER}:${MINIO_PASSWORD}@pipewise-minio:9000" \
    minio/mc ls pw 2>&1 | head -20
  echo "=== rocketmq broker log ==="
  docker logs --tail 40 pipewise-rocketmq-broker 2>&1
  echo "=== rocketmq cluster ==="
  docker exec pipewise-rocketmq-broker sh -c \
    "cd /home/rocketmq/rocketmq-5.3.1 && sh bin/mqadmin clusterList -n 127.0.0.1:9876" 2>&1 | head -30
  exit 0
fi

if [ "${1:-}" = "mqtest" ]; then
  echo "=== no-credential access from another container (should be denied) ==="
  docker run --rm --network pipewise-infra_default apache/rocketmq:5.3.1 \
    sh -c 'cd /home/rocketmq/rocketmq-5.3.1 && sh bin/mqadmin clusterList -n pipewise-rocketmq-namesrv:9876' 2>&1 | tail -20
  echo "=== broker ACL log lines ==="
  VOL=$(docker volume inspect pipewise-infra_brokerlogs -f '{{.Mountpoint}}' 2>/dev/null)
  grep -iE 'acl|access' "$VOL/rocketmqlogs/broker.log" 2>/dev/null | tail -20
  exit 0
fi

if [ "${1:-}" = "internaltest" ]; then
  BROKER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pipewise-rocketmq-broker)
  echo "broker container ip: $BROKER_IP"
  cp "$BASE/rocketmq/broker.conf" /tmp/broker.conf.bak
  sed -i "s/^brokerIP1 = .*/brokerIP1 = $BROKER_IP/" "$BASE/rocketmq/broker.conf"
  echo "[test] brokerIP1 -> $BROKER_IP, restarting..."
  docker restart pipewise-rocketmq-broker >/dev/null
  sleep 15
  echo "=== no credentials (expect ACL denial) ==="
  docker run --rm --entrypoint /bin/sh --network pipewise-infra_default \
    -v /tmp/rmq-test:/test:ro -v /tmp/rmq-lib:/rmqlib:ro apache/rocketmq:5.3.1 \
    -c 'timeout -s KILL 20 java -Drocketmq.client.logLevel=WARN -cp "/rmqlib/*:/test" RmqTest pipewise-rocketmq-namesrv:9876' 2>&1 | grep -E 'SEND_|Exception|ERROR' | head -5
  echo "=== with ACL credentials ==="
  docker run --rm --entrypoint /bin/sh --network pipewise-infra_default \
    -v /tmp/rmq-test:/test:ro -v /tmp/rmq-lib:/rmqlib:ro apache/rocketmq:5.3.1 \
    -c "timeout -s KILL 20 java -Drocketmq.client.logLevel=WARN -cp '/rmqlib/*:/test' RmqTest pipewise-rocketmq-namesrv:9876 '$ROCKETMQ_ACCESS_KEY' '$ROCKETMQ_SECRET_KEY'" 2>&1 | grep -E 'SEND_|Exception|ERROR' | head -5
  echo "[restore] brokerIP1 -> $PUBLIC_IP, restarting..."
  cp /tmp/broker.conf.bak "$BASE/rocketmq/broker.conf"
  docker restart pipewise-rocketmq-broker >/dev/null
  sleep 15
  docker logs --tail 3 pipewise-rocketmq-broker 2>&1 | tail -3
  exit 0
fi

if [ "${1:-}" = "rmqadmin" ]; then
  BROKER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pipewise-rocketmq-broker)
  echo "broker ip: $BROKER_IP"
  docker run --rm --entrypoint /bin/sh --network pipewise-infra_default --add-host "111.228.14.136:$BROKER_IP" \
    apache/rocketmq:5.3.1 \
    -c 'cd /home/rocketmq/rocketmq-5.3.1 && timeout 20 sh bin/mqadmin clusterList -n pipewise-rocketmq-namesrv:9876' 2>&1 | tail -30
  exit 0
fi

if [ "${1:-}" = "rmqone" ]; then
  shift
  BROKER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pipewise-rocketmq-broker)
  echo "broker ip: $BROKER_IP"
  timeout 40 docker run --rm --entrypoint /bin/sh --network pipewise-infra_default --add-host "111.228.14.136:$BROKER_IP" \
    -v /tmp/rmq-test:/test:ro -v /tmp/rmq-lib:/rmqlib:ro apache/rocketmq:5.3.1 \
    -c "cat /etc/hosts; echo '--- run'; timeout -s KILL 20 java -Drocketmq.client.logLevel=INFO -cp '/rmqlib/*:/test' RmqTest $*" 2>&1 | tail -60
  echo "host_timeout_exit=$?"
  exit 0
fi

if [ "${1:-}" = "rmqprobe" ]; then
  BROKER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pipewise-rocketmq-broker)
  echo "broker ip: $BROKER_IP"
  docker run --rm --entrypoint /bin/sh --network pipewise-infra_default --add-host "111.228.14.136:$BROKER_IP" \
    apache/rocketmq:5.3.1 -c '
      echo "--- dns:"; getent hosts 111.228.14.136
      echo "--- broker tcp:"; timeout 5 bash -c "echo > /dev/tcp/'"$BROKER_IP"'/10911" && echo ok || echo fail
      echo "--- namesrv tcp:"; timeout 5 bash -c "echo > /dev/tcp/pipewise-rocketmq-namesrv/9876" && echo ok || echo fail
    ' 2>&1
  exit 0
fi

if [ "${1:-}" = "rmqclient" ]; then
  BROKER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' pipewise-rocketmq-broker)
  echo "broker container ip: $BROKER_IP"
  docker run --rm apache/rocketmq:5.3.1 java -version 2>&1 | head -2
  echo "=== no credentials (expect ACL failure) ==="
  docker run --rm --entrypoint /bin/sh --network pipewise-infra_default --add-host "111.228.14.136:$BROKER_IP" \
    -v /tmp/rmq-test:/test:ro -v /tmp/rmq-lib:/rmqlib:ro apache/rocketmq:5.3.1 \
    -c 'timeout -s KILL 20 java -Drocketmq.client.logLevel=WARN -cp "/rmqlib/*:/test" RmqTest pipewise-rocketmq-namesrv:9876' 2>&1 | grep -E 'SEND_|Exception|ERROR' | head -5
  echo "=== with ACL credentials ==="
  docker run --rm --entrypoint /bin/sh --network pipewise-infra_default --add-host "111.228.14.136:$BROKER_IP" \
    -v /tmp/rmq-test:/test:ro -v /tmp/rmq-lib:/rmqlib:ro apache/rocketmq:5.3.1 \
    -c "timeout -s KILL 20 java -Drocketmq.client.logLevel=WARN -cp '/rmqlib/*:/test' RmqTest pipewise-rocketmq-namesrv:9876 '$ROCKETMQ_ACCESS_KEY' '$ROCKETMQ_SECRET_KEY'" 2>&1 | grep -E 'SEND_|Exception|ERROR' | head -5
  exit 0
fi

if [ "${1:-}" = "miniocheck" ]; then
  docker run --rm --network pipewise-infra_default \
    -e MC_HOST_pw="http://${MINIO_USER}:${MINIO_PASSWORD}@pipewise-minio:9000" \
    minio/mc ls pw 2>&1
  echo "=== admin info ==="
  docker run --rm --network pipewise-infra_default \
    -e MC_HOST_pw="http://${MINIO_USER}:${MINIO_PASSWORD}@pipewise-minio:9000" \
    minio/mc admin info pw 2>&1 | head -12
  exit 0
fi

# ---------- 2. RocketMQ 配置 ----------
cat > "$BASE/rocketmq/broker.conf" <<EOF
brokerClusterName = DefaultCluster
brokerName = broker-a
brokerId = 0
deleteWhen = 04
fileReservedTime = 48
brokerRole = ASYNC_MASTER
flushDiskType = ASYNC_FLUSH
namesrvAddr = pipewise-rocketmq-namesrv:9876
brokerIP1 = $PUBLIC_IP
listenPort = 10911
storePathRootDir = /home/rocketmq/store
storePathCommitLog = /home/rocketmq/store/commitlog
autoCreateTopicEnable = true
autoCreateSubscriptionGroup = true
aclEnable = true
aclRPCHook = org.apache.rocketmq.acl.plain.PlainAccessValidator
EOF

cat > "$BASE/rocketmq/plain_acl.yml" <<EOF
globalWhiteRemoteAddresses:
  - 127.0.0.1
accounts:
  - accessKey: $ROCKETMQ_ACCESS_KEY
    secretKey: $ROCKETMQ_SECRET_KEY
    admin: true
    defaultTopicPerm: PUB|SUB
    defaultGroupPerm: PUB|SUB
EOF
chmod 644 "$BASE/rocketmq/broker.conf" "$BASE/rocketmq/plain_acl.yml"

# ---------- 3. docker-compose ----------
cat > "$BASE/docker-compose.yml" <<'EOF'
name: pipewise-infra

services:
  postgres:
    image: postgres:16-alpine
    container_name: pipewise-postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: pipewise
      POSTGRES_PASSWORD: ${PG_PASSWORD}
      POSTGRES_DB: pipewise
      TZ: Asia/Shanghai
      PGDATA: /var/lib/postgresql/data/pgdata
    ports:
      - "0.0.0.0:5434:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
    command:
      - postgres
      - -c
      - max_connections=200
      - -c
      - shared_buffers=256MB
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U pipewise -d pipewise"]
      interval: 10s
      timeout: 5s
      retries: 12

  redis:
    image: redis:7-alpine
    container_name: pipewise-redis
    restart: unless-stopped
    command:
      - redis-server
      - --requirepass
      - ${REDIS_PASSWORD}
      - --appendonly
      - "yes"
      - --protected-mode
      - "no"
    ports:
      - "0.0.0.0:6380:6379"
    volumes:
      - redisdata:/data
    healthcheck:
      test: ["CMD-SHELL", "redis-cli -a ${REDIS_PASSWORD} ping | grep PONG"]
      interval: 10s
      timeout: 5s
      retries: 12

  minio:
    image: minio/minio:latest
    container_name: pipewise-minio
    restart: unless-stopped
    environment:
      MINIO_ROOT_USER: ${MINIO_USER}
      MINIO_ROOT_PASSWORD: ${MINIO_PASSWORD}
      TZ: Asia/Shanghai
    command: server /data --console-address ":9001"
    ports:
      - "0.0.0.0:9010:9000"
      - "0.0.0.0:9011:9001"
    volumes:
      - miniodata:/data

  rocketmq-namesrv:
    image: apache/rocketmq:5.3.1
    container_name: pipewise-rocketmq-namesrv
    restart: unless-stopped
    command: sh mqnamesrv
    environment:
      JAVA_OPT_EXT: "-Xms256m -Xmx256m -Xmn128m"
    ports:
      - "0.0.0.0:9876:9876"
    volumes:
      - namesrvlogs:/home/rocketmq/logs

  rocketmq-broker:
    image: apache/rocketmq:5.3.1
    container_name: pipewise-rocketmq-broker
    restart: unless-stopped
    depends_on:
      - rocketmq-namesrv
    command: sh mqbroker -c /home/rocketmq/rocketmq-5.3.1/conf/broker.conf
    environment:
      NAMESRV_ADDR: pipewise-rocketmq-namesrv:9876
      JAVA_OPT_EXT: "-Xms512m -Xmx512m -Xmn256m"
    ports:
      - "0.0.0.0:10911:10911"
      - "0.0.0.0:10909:10909"
    volumes:
      - ./rocketmq/broker.conf:/home/rocketmq/rocketmq-5.3.1/conf/broker.conf:ro
      - ./rocketmq/plain_acl.yml:/home/rocketmq/rocketmq-5.3.1/conf/plain_acl.yml:ro
      - brokerstore:/home/rocketmq/store
      - brokerlogs:/home/rocketmq/logs

volumes:
  pgdata:
  redisdata:
  miniodata:
  namesrvlogs:
  brokerstore:
  brokerlogs:
EOF

cd "$BASE"
echo "[pull] pulling images (may take a few minutes)..."
IMAGES=(
  postgres:16-alpine
  redis:7-alpine
  minio/minio:latest
  apache/rocketmq:5.3.1
)
for img in "${IMAGES[@]}"; do
  if docker image inspect "$img" >/dev/null 2>&1; then
    echo "[pull] $img already present"
    continue
  fi
  ok=0
  for attempt in 1 2 3 4; do
    echo "[pull] $img (attempt $attempt)"
    if DOCKER_CLIENT_TIMEOUT=600 docker pull "$img"; then ok=1; break; fi
    echo "[pull] $img failed, retrying in 10s..."
    sleep 10
  done
  if [ "$ok" != 1 ]; then
    echo "[pull] ERROR: $img could not be pulled after retries"
  fi
done

echo "[up] preparing RocketMQ volumes (uid 3000) ..."
docker volume create pipewise-infra_brokerstore >/dev/null
docker volume create pipewise-infra_brokerlogs >/dev/null
docker volume create pipewise-infra_namesrvlogs >/dev/null
docker run --rm --user root \
  -v pipewise-infra_brokerstore:/mnt/store \
  -v pipewise-infra_brokerlogs:/mnt/brokerlogs \
  -v pipewise-infra_namesrvlogs:/mnt/namesrvlogs \
  apache/rocketmq:5.3.1 \
  sh -c 'chown -R 3000:3000 /mnt/store /mnt/brokerlogs /mnt/namesrvlogs' >/dev/null

echo "[up] starting containers..."
docker compose up -d

echo "[wait] waiting for postgres / redis / minio ..."
for i in $(seq 1 30); do
  pg_ok=0; redis_ok=0; minio_ok=0
  docker exec pipewise-postgres pg_isready -U pipewise -d pipewise >/dev/null 2>&1 && pg_ok=1
  docker exec pipewise-redis redis-cli -a "$REDIS_PASSWORD" ping 2>/dev/null | grep -q PONG && redis_ok=1
  curl -fsS --max-time 3 http://127.0.0.1:9010/minio/health/live >/dev/null 2>&1 && minio_ok=1
  if [ "$pg_ok" = 1 ] && [ "$redis_ok" = 1 ] && [ "$minio_ok" = 1 ]; then
    echo "[ok] postgres/redis/minio ready"
    break
  fi
  sleep 2
done

# ---------- 4. MinIO bucket ----------
echo "[minio] ensuring buckets ..."
for BUCKET in pipewise student; do
  docker run --rm --network pipewise-infra_default \
    -e MC_HOST_pw="http://${MINIO_USER}:${MINIO_PASSWORD}@pipewise-minio:9000" \
    minio/mc mb -p "pw/$BUCKET" >/dev/null 2>&1 || true
done

# ---------- 5. 状态与凭据 ----------
docker compose ps

echo
echo "================ PipeWise infra ================"
echo "PUBLIC_IP        = $PUBLIC_IP"
echo "PostgreSQL       = $PUBLIC_IP:5434  db=pipewise user=pipewise"
echo "Redis            = $PUBLIC_IP:6380  password=$REDIS_PASSWORD"
echo "MinIO API        = $PUBLIC_IP:9010  console=$PUBLIC_IP:9011"
echo "MinIO user/pass  = $MINIO_USER / $MINIO_PASSWORD"
echo "RocketMQ namesrv = $PUBLIC_IP:9876  broker=$PUBLIC_IP:10911"
echo "RocketMQ ACL     = $ROCKETMQ_ACCESS_KEY / $ROCKETMQ_SECRET_KEY"
echo "PG password      = see $ENV_FILE (root only)"
echo "==============================================="

# 生成一份人类可读凭据文件（root 600）
cat > "$BASE/credentials.txt" <<EOF
PipeWise single-node middleware credentials
Generated: $(date -Is)

PostgreSQL
  host: $PUBLIC_IP
  port: 5434
  database: pipewise
  user: pipewise
  password: $PG_PASSWORD
  jdbc: jdbc:postgresql://$PUBLIC_IP:5434/pipewise
  psql: psql -h $PUBLIC_IP -p 5434 -U pipewise -d pipewise

Redis
  host: $PUBLIC_IP
  port: 6380
  password: $REDIS_PASSWORD
  url: redis://:$REDIS_PASSWORD@$PUBLIC_IP:6380/0

MinIO
  endpoint: http://$PUBLIC_IP:9010
  console: http://$PUBLIC_IP:9011
  access key: $MINIO_USER
  secret key: $MINIO_PASSWORD
  buckets: pipewise, student

RocketMQ
  nameserver: $PUBLIC_IP:9876
  broker: $PUBLIC_IP:10911
  access key: $ROCKETMQ_ACCESS_KEY
  secret key: $ROCKETMQ_SECRET_KEY
EOF
chmod 600 "$BASE/credentials.txt"
echo "[done] credentials written to $BASE/credentials.txt"
