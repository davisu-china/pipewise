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

当前状态：重新开发准备中。
