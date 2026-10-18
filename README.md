# PipeWise

AI 时代的流程引擎平台：**定义流程 → 发布版本 → 创建实例**。

> 旧实现（FastAPI MVP、Flowable 验证骨架、旧 React 前端）已于 2026-10-18 从 `main`
> 移除，历史保留在 commit `319e1b3`。当前按新的技术方案重新开发。

## 文档

- 产品需求文档 PRD v1.1 → https://davisu-china.github.io/pipewise/
- **技术方案（Java 自研内核 + React）** → https://davisu-china.github.io/pipewise/tech-design/
  - 源文件：[docs/tech-design-self-built-java-react.html](docs/tech-design-self-built-java-react.html)

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
