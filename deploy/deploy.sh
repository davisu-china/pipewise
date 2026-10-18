#!/usr/bin/env bash
#
# PipeWise 一键部署（**需要 root**）：
#   sudo ./deploy/deploy.sh
#
# 形态：子路径 https://<SITE>/pipewise/（主站 nginx 反代到 127.0.0.1:8121）。
# 选子路径而不是子域名，是因为 pipewise.jianjiange.site 还没有 DNS 记录；
# 之后加了 DNS 想切独立域名，只需把这里换成 domain 模式（见文末提示）。
#
# 幂等：重复执行是安全的——库/种子/环境变量文件已存在时保留，nginx 配置按 MARK 判断。
#
# 可覆盖变量：
#   SUBPATH=pipewise  SITE=jianjiange.site  API_PORT=8121  SEED=1
#   BASIC_USER=pipewise  BASIC_PASS=<留空则首次部署时随机生成>
#   PIP_INDEX_URL=https://pypi.tuna.tsinghua.edu.cn/simple
set -euo pipefail

SUBPATH="${SUBPATH:-pipewise}"
SITE="${SITE:-jianjiange.site}"
API_PORT="${API_PORT:-8121}"
API_DIR="${API_DIR:-/opt/pipewise}"
SEED="${SEED:-1}"
BASIC_USER="${BASIC_USER:-pipewise}"
BASIC_PASS="${BASIC_PASS:-}"

# REPO 必须先有值：下面所有路径（含 env.local）都基于它
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="$(stat -c '%U' "$REPO")"
[ "$RUN_USER" = "root" ] && RUN_USER="metabot"

# sudo 会清掉环境变量；密码可放在 deploy/env.local（不进仓库）里
if [ -z "$BASIC_PASS" ] && [ -f "$REPO/deploy/env.local" ]; then
  BASIC_PASS="$(grep -E '^BASIC_PASS=' "$REPO/deploy/env.local" 2>/dev/null | tail -1 | cut -d= -f2- || true)"
fi

PG_PORT="${PG_PORT:-5433}"
PG_USER="${PG_USER:-mutual}"
DB_NAME="${DB_NAME:-pipewise_prod}"
DATABASE_URL="postgresql+psycopg://${PG_USER}@127.0.0.1:${PG_PORT}/${DB_NAME}"

NGINX_CONF="${NGINX_CONF:-/opt/jianjian/deploy/nginx/nginx.conf}"
NGINX_CONTAINER="${NGINX_CONTAINER:-jianjian-nginx}"
# htpasswd 必须落在容器的 bind mount 里：只挂了 nginx/nginx.conf、nginx/ssl、nginx/html。
HTPASSWD_HOST="${HTPASSWD_HOST:-/opt/jianjian/deploy/nginx/ssl/pipewise.htpasswd}"
HTPASSWD_CONTAINER="/etc/nginx/ssl/pipewise.htpasswd"
MARK="# ===== PipeWise ====="
WEB_URL_PATH="/${SUBPATH}/"

log(){ printf '\n\033[36m==> %s\033[0m\n' "$*"; }
warn(){ printf '\033[33m! %s\033[0m\n' "$*" >&2; }
die(){ printf '\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

# ---------------------------------------------------------------- 1. 前置检查
log "前置检查"
[ "$(id -u)" = "0" ] || die "请用 root 运行：sudo $0"
[ -f "$NGINX_CONF" ] || die "找不到 nginx 配置：$NGINX_CONF"
command -v docker >/dev/null || die "找不到 docker"
docker inspect "$NGINX_CONTAINER" >/dev/null 2>&1 || die "nginx 容器不存在：$NGINX_CONTAINER"
[ -x /home/metabot/.local/bin/uv ] || die "找不到 uv（/home/metabot/.local/bin/uv）；先装 uv"
# root 的 $HOME=/root，这里必须用绝对路径指向 metabot 的 PG 客户端
export LD_LIBRARY_PATH="${LD_LIBRARY_PATH:-/home/metabot/.local/pg/usr/pgsql-14/lib}"
export PATH="/home/metabot/.local/pg/usr/pgsql-14/bin:$PATH"
command -v psql >/dev/null || die "找不到 psql（/home/metabot/.local/pg/usr/pgsql-14/bin）"
[ -d "$REPO/backend" ] || die "仓库结构不对：$REPO"
echo "  ✓ root / nginx 容器 / uv / psql 就绪（repo=$REPO，user=$RUN_USER）"

# ---------------------------------------------------------------- 2. 构建
log "构建后端虚拟环境"
sudo -u "$RUN_USER" -H bash -lc "
  set -e
  cd '$REPO/backend'
  [ -x .venv/bin/python ] || /home/metabot/.local/bin/uv venv --python 3.12 .venv
  /home/metabot/.local/bin/uv pip install --python .venv/bin/python \
    -i '${PIP_INDEX_URL:-https://pypi.tuna.tsinghua.edu.cn/simple}' \
    -r requirements.txt >/dev/null
" || die "依赖安装失败"
echo "  ✓ 虚拟环境就绪"

# ---------------------------------------------------------------- 3. 数据库与种子
log "准备数据库"
psql "postgresql://${PG_USER}@127.0.0.1:${PG_PORT}/postgres" -X -tAc \
  "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1 \
  || psql "postgresql://${PG_USER}@127.0.0.1:${PG_PORT}/postgres" -X \
       -c "CREATE DATABASE ${DB_NAME} OWNER ${PG_USER}" >/dev/null
echo "  ✓ 数据库 ${DB_NAME} 就绪"

if [ "$SEED" = "1" ]; then
  # PORT 参与种子里的 webhook 地址（指向本机 API，走内网，不经过 Basic Auth）
  sudo -u "$RUN_USER" -H \
    env PORT="$API_PORT" DATABASE_URL="$DATABASE_URL" \
    bash -lc "cd '$REPO/backend' && .venv/bin/python -m app.seed" \
    | sed 's/^/  /' || die "种子失败"
  echo "  ✓ 种子数据（组织/表单/三个演示流程）"
fi

# ---------------------------------------------------------------- 4. 运行环境
log "写入运行环境"
mkdir -p "$API_DIR"
chown "$RUN_USER":"$(id -gn "$RUN_USER")" "$API_DIR"
ENV_FILE="$API_DIR/api.env"
if [ ! -f "$ENV_FILE" ]; then
  cat > "$ENV_FILE" <<ENV
# PipeWise 运行环境（root 600；密钥不要进仓库）
DATABASE_URL=${DATABASE_URL}
PORT=${API_PORT}
# 演示模式：开放 /dev/demo-users 给前端用户切换器用。
# 接 SSO 之前靠 nginx Basic Auth 做外层保护；正式对外时改成 0。
PIPEWISE_DEMO=1
DISPATCH_INTERVAL_S=2
SCRIPT_TIMEOUT_MS=3000
ENV
  chmod 600 "$ENV_FILE"
  echo "  ✓ 已生成 $ENV_FILE"
else
  echo "  ✓ 保留已有 $ENV_FILE"
fi

# 本机覆盖（可选、不进仓库）：例如临时关掉演示模式 / 改脚本超时
OVERRIDE_FILE="$REPO/deploy/env.local"
if [ -f "$OVERRIDE_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    case "$line" in ''|'#'*) continue ;; esac
    case "$line" in *=*) ;; *) warn "跳过无法解析的一行: $line"; continue ;; esac
    key="${line%%=*}"
    case "$key" in BASIC_USER|BASIC_PASS) continue ;; esac   # 部署期凭据，不属于应用配置
    if [ "$(grep -E "^${key}=" "$ENV_FILE" 2>/dev/null | tail -1 || true)" = "$line" ]; then continue; fi
    { grep -vE "^${key}=" "$ENV_FILE" || true; printf '%s\n' "$line"; } > "$ENV_FILE.tmp"
    cat "$ENV_FILE.tmp" > "$ENV_FILE"; rm -f "$ENV_FILE.tmp"; chmod 600 "$ENV_FILE"
    echo "  ✓ $key 已从 deploy/env.local 覆盖"
  done < "$OVERRIDE_FILE"
fi

# ---------------------------------------------------------------- 5. systemd
log "安装 systemd 服务"
cat > /etc/systemd/system/pipewise-api.service <<UNIT
[Unit]
Description=PipeWise API
After=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${REPO}/backend
EnvironmentFile=${ENV_FILE}
# 本机 systemd 是 219，不支持 StandardOutput=append:（240+ 才有），
# 用 sh -c 重定向；注意 /opt/pipewise 必须是运行用户可写的，否则日志文件建不出来。
ExecStart=/bin/sh -c 'exec .venv/bin/uvicorn app.main:app --host 127.0.0.1 --port \${PORT} >> ${API_DIR}/api.log 2>&1'
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT

systemctl daemon-reload
systemctl enable pipewise-api >/dev/null
systemctl restart pipewise-api

printf '  等待 API 就绪'
API_OK=0
for _ in $(seq 1 25); do
  if curl -fsS -o /dev/null "http://127.0.0.1:${API_PORT}/api/v1/health" 2>/dev/null; then API_OK=1; break; fi
  printf '.'; sleep 1
done
echo
if [ "$API_OK" != "1" ]; then
  echo "--- journalctl ---"; journalctl -u pipewise-api -n 30 --no-pager 2>/dev/null || true
  echo "--- ${API_DIR}/api.log ---"; tail -30 "${API_DIR}/api.log" 2>/dev/null || true
  die "API 没起来"
fi
echo "  ✓ API 在跑（127.0.0.1:${API_PORT}）"

# ---------------------------------------------------------------- 6. Basic Auth
log "准备访问凭据"
if [ ! -f "$HTPASSWD_HOST" ]; then
  [ -n "$BASIC_PASS" ] || BASIC_PASS="$(openssl rand -base64 24 | tr -d '/+=' | head -c 16)"
  hash="$(openssl passwd -apr1 "$BASIC_PASS")"
  mkdir -p "$(dirname "$HTPASSWD_HOST")"
  printf '%s:%s\n' "$BASIC_USER" "$hash" > "$HTPASSWD_HOST"
  chmod 644 "$HTPASSWD_HOST"   # nginx worker（容器内 uid 101）要能读
  cat > "$API_DIR/access.txt" <<ACCESS
PipeWise 演示地址：https://${SITE}${WEB_URL_PATH}
用户名：${BASIC_USER}
密码：  ${BASIC_PASS}
（改密码：删掉 ${HTPASSWD_HOST} 后重跑本脚本，或用 BASIC_PASS=新密码 重跑）
ACCESS
  chmod 600 "$API_DIR/access.txt"
  echo "  ✓ 已生成凭据（见 ${API_DIR}/access.txt）"
  echo "    用户名：${BASIC_USER}    密码：${BASIC_PASS}"
else
  echo "  ✓ 沿用已有凭据 ${HTPASSWD_HOST}（要重置就删掉它再重跑）"
fi

# ---------------------------------------------------------------- 7. nginx
log "配置 nginx（子路径 ${WEB_URL_PATH}）"

if grep -qF "$MARK" "$NGINX_CONF"; then
  echo "  ✓ 配置已存在（改端口请手动改后 reload）"
else
  cp "$NGINX_CONF" "$NGINX_CONF.bak.pipewise.$(date +%Y%m%d-%H%M%S)"

  # 插入点：主站 server 块（listen 443 且 server_name 含 $SITE）的收尾大括号。
  # 不能取文件里最后一个 }（那是 http{} 的收尾，裸 location 放进去非法），
  # 也不能猜——主站 server 夹在文件中间，只能按括号深度算。
  INSERT_AT="$(awk -v site="$SITE" '
    function delta(s,   i, c, n) {
      n = 0
      for (i = 1; i <= length(s); i++) {
        c = substr(s, i, 1)
        if (c == "{") n++
        else if (c == "}") n--
      }
      return n
    }
    function iscomment(s) { return s ~ /^[[:space:]]*#/ }
    { line[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        if (iscomment(line[i])) continue
        if (line[i] !~ /^[[:space:]]*server[[:space:]]*\{/) continue
        d = 0; has443 = 0; named = 0; end = 0
        for (j = i; j <= NR; j++) {
          d += delta(line[j])
          if (line[j] ~ /^[[:space:]]*listen[[:space:]]+443([[:space:]]|;)/) has443 = 1
          if (line[j] ~ /^[[:space:]]*server_name[[:space:]]/) {
            s = line[j]
            sub(/^[[:space:]]*server_name[[:space:]]+/, "", s)
            sub(/;.*$/, "", s)
            cnt = split(s, tok, /[[:space:]]+/)
            for (k = 1; k <= cnt; k++) if (tok[k] == site || tok[k] == "www." site) named = 1
          }
          if (d <= 0) { end = j; break }
        }
        if (end && has443 && named) { print end; exit 0 }
      }
      print "ERR"; exit 1
    }' "$NGINX_CONF")" || INSERT_AT="ERR"
  case "$INSERT_AT" in
    ""|ERR|*[!0-9]*) die "找不到主站 server 块（SITE=$SITE），请手工把 location 加进去" ;;
  esac
  echo "  ✓ 插入点：第 ${INSERT_AT} 行前"

  cat > /tmp/pipewise.loc <<LOC

        ${MARK}
        # 不带尾斜杠时前缀 location 不命中，会落到主站 location / 返回主站 404。
        location = ${WEB_URL_PATH%/} {
            return 301 ${WEB_URL_PATH}\$is_args\$args;
        }
        # ^~ 让前缀匹配终止正则评估：主站有按图片后缀匹配的 location，
        # 不加它 /pipewise/xxx.png 会被抢去主站前端。
        location ^~ ${WEB_URL_PATH} {
            auth_basic           "PipeWise";
            auth_basic_user_file ${HTPASSWD_CONTAINER};
            # 容器的 127.0.0.1 是它自己；宿主机是 docker 网桥网关 172.17.0.1。
            proxy_pass           http://172.17.0.1:${API_PORT}/;
            proxy_http_version   1.1;
            proxy_set_header Host              \$host;
            proxy_set_header X-Real-IP         \$remote_addr;
            proxy_set_header X-Forwarded-For   \$proxy_add_x_forwarded_for;
            proxy_set_header X-Forwarded-Proto \$scheme;
            proxy_buffering off;
            proxy_read_timeout  120s;
        }
LOC

  awk -v ins=/tmp/pipewise.loc -v at="$INSERT_AT" '
    { line[NR] = $0 }
    END {
      for (i = 1; i <= NR; i++) {
        if (i == at + 0) { while ((getline l < ins) > 0) print l; close(ins) }
        print line[i]
      }
    }' "$NGINX_CONF" > /tmp/pipewise.nginx.new
  cat /tmp/pipewise.nginx.new > "$NGINX_CONF"   # 原地覆盖：不能 sed -i（换 inode 容器读不到）
  echo "  ✓ 已插入配置"
fi

# 配置测试失败必须回滚（否则一次笔误会把整台机器上的所有站点打挂）
LATEST_BAK="$(ls -1t "$NGINX_CONF".bak.pipewise.* 2>/dev/null | head -1 || true)"
if ! docker exec "$NGINX_CONTAINER" nginx -t; then
  if [ -n "$LATEST_BAK" ]; then
    cat "$LATEST_BAK" > "$NGINX_CONF"
    docker exec "$NGINX_CONTAINER" nginx -t && docker exec "$NGINX_CONTAINER" nginx -s reload || true
    die "nginx -t 失败，已回滚到 $(basename "$LATEST_BAK")"
  fi
  die "nginx -t 失败"
fi
docker exec "$NGINX_CONTAINER" nginx -s reload
echo "  ✓ nginx 已 reload"

# ---------------------------------------------------------------- 8. 验收
log "验收"
code="$(curl -s -o /tmp/pipewise.verify.html -w '%{http_code}' -u "${BASIC_USER}:${BASIC_PASS:-__existing__}" \
  "https://${SITE}${WEB_URL_PATH}" || true)"
if [ "$code" = "200" ] && grep -q "PipeWise" /tmp/pipewise.verify.html; then
  echo "  ✓ 页面 https://${SITE}${WEB_URL_PATH} -> 200"
elif [ "$code" = "401" ] && [ -z "$BASIC_PASS" ]; then
  echo "  ✓ 页面可达（401 = Basic Auth 生效；凭据见 ${API_DIR}/access.txt）"
else
  warn "页面自检返回 $code（凭据可能是旧密码，用 ${API_DIR}/access.txt 里的试一次）"
fi
health="$(curl -s -o /dev/null -w '%{http_code}' -u "${BASIC_USER}:${BASIC_PASS:-__existing__}" \
  "https://${SITE}${WEB_URL_PATH}api/v1/health" || true)"
[ "$health" = "200" ] && echo "  ✓ API /health -> 200" || warn "API /health 返回 $health"
noauth="$(curl -s -o /dev/null -w '%{http_code}' "https://${SITE}${WEB_URL_PATH}api/v1/health" || true)"
[ "$noauth" = "401" ] && echo "  ✓ 未带凭据 -> 401（Basic Auth 生效）" || warn "未带凭据返回 $noauth（预期 401）"

cat <<EOF

════════════════════════════════════════════
 访问地址： https://${SITE}${WEB_URL_PATH}
 凭据：     ${API_DIR}/access.txt（用户名 ${BASIC_USER}）
 服务：     systemctl status pipewise-api（日志 ${API_DIR}/api.log）
 数据库：   ${DB_NAME} @ 127.0.0.1:${PG_PORT}
 演示模式： PIPWISE_DEMO 在 ${ENV_FILE} 里；正式对外前改成 0 并接 SSO
EOF

cat <<'EOF'

后续：
  - 改了代码：git pull && sudo ./deploy/deploy.sh（幂等，只重启服务）
  - 想切独立域名：先在 Cloudflare 加 pipewise.jianjiange.site 的 A/AAAA 记录，
    再把本脚本改成 domain 模式（参考 mutual-app/deploy/deploy.sh 的 server 块）
EOF
