# PipeWise

AI 时代的流程引擎平台：**定义流程 → 发布版本 → 创建实例**。

> 旧实现（FastAPI MVP、Flowable 验证骨架、旧 React 前端）已于 2026-10-18 从 `main`
> 移除，历史保留在 commit `319e1b3`。当前按新的技术方案重新开发。

## 文档

- 产品需求文档 PRD v1.1 → https://davisu-china.github.io/pipewise/
- **技术方案（Java 自研内核 + React）** → https://davisu-china.github.io/pipewise/tech-design/
  - 源文件：[docs/tech-design-self-built-java-react.html](docs/tech-design-self-built-java-react.html)
- **学员分期开发计划（18 周 / 9 阶段）** → https://davisu-china.github.io/pipewise/dev-plan/

## 中间件（单机）

已在 `111.228.14.136` 部署 PostgreSQL 16 / Redis 7 / MinIO / RocketMQ 5.3.1，
Docker Compose 管理，端口分别为 `5434 / 6380 / 9010·9011 / 9876·10911·10909`。
连接方式、代码示例与外网放行说明见 [docs/middleware-deploy.md](docs/middleware-deploy.md)，
公开版在线手册：https://davisu-china.github.io/pipewise/middleware/ （不含密码）。
密码不在仓库内：部署机 `/opt/pipewise-infra/credentials.txt`（root 600），或执行
`sudo deploy/deploy.sh show` 查看；含密码的完整版部署手册由项目负责人私发。

## 线上演示

- 地址：https://jianjiange.site/pipewise/
- 访问方式：应用内登录（账号 `pipewise`，密码见部署机 `/opt/pipewise/access.txt`）；
  登录后写 HttpOnly Cookie（Redis 会话，7 天），nginx 不再弹 Basic Auth
- 部署命令：`sudo deploy/deploy.sh app`（安装 systemd API/Worker、发布前端、切换 nginx 反代）

## 本地开发（P0 骨架）

前置：Java 21、Maven 3.9+、Node 22+。

```bash
# 1) 准备环境变量（不要提交 server/.env）
cp server/.env.example server/.env
# 编辑 server/.env 填入中间件密码，然后：
set -a; source server/.env; set +a

# 2) 构建并启动后端
cd server
mvn -DskipTests package
java -jar pw-api/target/pw-api-0.1.0-SNAPSHOT.jar      # API :18081
java -jar pw-worker/target/pw-worker-0.1.0-SNAPSHOT.jar # Worker 心跳

# 3) 启动前端（另开终端）
cd web
NODE_ENV=development npm install
NODE_ENV=development npm run dev
```

打开 <http://127.0.0.1:5173/> 查看环境自检，API 默认 `18081`。
本机如果 `tsc`/`vite` 找不到，通常是全局 `NODE_ENV=production` 导致 npm 跳过 devDependencies，
安装时显式带上 `NODE_ENV=development`。

## 目标架构

- **后端**：Java 21 + Spring Boot 3.5，模块化单体，拆 `api` / `engine` 两种运行形态
- **执行内核**：自研令牌驱动引擎，不依赖 Flowable 等第三方流程引擎
- **存储与中间件**：PostgreSQL 16（唯一事实源）、Redis 7（缓存）、RocketMQ 5（事件）、MinIO（对象存储）
- **脚本**：Python 独立 Runner 进程池，与 Java 内核隔离
- **前端**：React 18 + TypeScript + Vite + shadcn/ui + React Flow

## 规划中的目录

```text
server/            # Java 多模块：pw-common / pw-engine / pw-api / pw-worker ...
script-runner/     # Python 脚本沙箱
web/               # React 前端（重建）
deploy/            # 部署脚本与配置
docs/              # PRD 与技术方案
```

当前状态：P0 骨架 + P1 定义/版本/设计器 + P2 执行内核 + P3 签核已落地。

## P1 已实现

- 流程定义列表、新建、草稿保存（`draftRev` 乐观锁）
- 快照结构：节点、边、变量、settings；发布时计算 SHA-256
- 发布前校验：start/end 数量、入边/出边、不可达节点、XOR 默认边、变量引用、脚本/表单引用
- 不可变版本：发布 v1/v2、版本列表、切换默认版本
- React Flow 设计器：开始 / 审批 / 排他网关 / 结束、条件连线、节点配置、变量编辑、JSON 导入导出、校验与发布

## P2 已实现

- 运行时表：`wf_instance` / `wf_token` / `wf_node_instance` / `wf_execution_job` / `wf_task` / `wf_variable` / `wf_event_outbox`
- 创建实例（`businessKey` 唯一）、令牌激活、start / approval / end 执行器
- PG `SKIP LOCKED` 作业队列、租约与重试、实例级 advisory lock
- 任务列表 / 详情 / 完成（approve / reject），重复提交幂等
- 实例列表 / 详情 / 当前节点 / 时间线 / 变量；前端实例与待办页面
- Worker 需单独启动，使用与 API 相同的 `PW_PG_*` 环境变量；停机后重启会从 pending 作业继续

## P3 已实现

- `wf_sign_session`：或签 ANY / 并签 ALL / 竞签 RACE
- 并签支持并行/串行、全部同意或同意比例、一票否决或收集完再判
- 审批人：逗号分隔用户列表，`initiator` 表示发起人
- 加签、转交、退回、撤回；退回策略支持终止 / 退回发起人 / 退回指定节点
- 前端设计器增加签核配置；待办页支持同意 / 驳回 / 退回 / 加签 / 转交
- 决策引擎纯函数单测覆盖三种模式与通过规则
