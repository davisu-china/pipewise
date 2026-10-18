# java-mvp（Flowable 验证骨架）

> **仅用于验证「定义 → 实例 → 审批 → 结束」最小闭环，不是生产实现。**
> 生产方案为纯自研 Java 执行内核，不依赖 Flowable，见
> [`docs/tech-design-self-built-java-react.html`](../docs/tech-design-self-built-java-react.html)。

## 内容

- Spring Boot 3.5 + Flowable 7 + PostgreSQL
- `src/main/resources/processes/`：请假审批与或签 / 并签 / 竞签演示流程
- 启动类：`com.pipewise.flowable.FlowableMvpApplication`
- 默认端口 `8082`；数据库连接可用 `DB_URL` / `DB_USER` / `DB_PASSWORD` 覆盖

## 运行

```bash
cd java-mvp/backend
mvn spring-boot:run
```

骨架开启 `database-schema-update: true` 自动建 Flowable 表；仅限本地开发使用。

## 与生产方案的关系

本目录用于在 M0 之前快速验证流程语义，M1 完成后归档删除。
新代码统一放在仓库的 `server/` 多模块中，设计见技术方案文档。
