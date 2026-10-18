# pipewise
ai 时代的流程引擎

企业级流程引擎平台：**定义流程 → 发布版本 → 创建实例**。覆盖人工审批（或签／并签／竞签）、
表单引擎（节点×字段权限矩阵）、并行网关与汇聚、流程上下文系统与节点脚本计算。

## 文档

- 产品需求文档 PRD v1.1 → https://davisu-china.github.io/pipewise/
- **技术方案（实现契约）** → [docs/tech-design.md](docs/tech-design.md)：数据模型、令牌执行算法、
  签核裁决表、事务与幂等、脚本沙箱、API、与 PRD 的差异清单。

## 快速开始（5 分钟）

需要 Python 3.12 + PostgreSQL。

```bash
# 1) 建库
psql -h 127.0.0.1 -p 5432 -U postgres -c "CREATE DATABASE pipewise"

# 2) 装依赖并起服务
cd backend
uv venv --python 3.12 .venv
uv pip install -r requirements.txt
export DATABASE_URL="postgresql+psycopg://postgres@127.0.0.1:5432/pipewise"
.venv/bin/python -m app.seed          # 建表 + 种子（组织/表单/三个演示流程）
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8100
```

浏览器打开 <http://127.0.0.1:8100/>。右上角可以切换演示用户（张三/李四/王芳/管理员……）。

## 演示账号

| 用户 | token | 角色 | 在这套演示里能做什么 |
|---|---|---|---|
| 张三 | `tok_zhangsan` | user | 发起请假/合同/报销；重提 |
| 李四 | `tok_lisi` | user, owner | 直属主管审批；竞签 |
| 张伟 | `tok_zhangwei` | user, director | 部门负责人 / 总监审批 |
| 王芳 | `tok_wangfang` | user, hr, owner | HR 备案；竞签 |
| 刘敏 / 陈立 / 周强 | `tok_liumin` / `tok_chenli` / `tok_zhouqiang` | finance / legal / risk | 三方会签 |
| 流程设计师 | `tok_designer` | designer | 建/改草稿、校验、试跑、提交发布 |
| 系统管理员 | `tok_admin` | admin | 发布/下线、运维干预、看全部实例 |

（`/api/v1/dev/demo-users` 会把 token 暴露给演示前端；生产环境删掉它，接 SSO。）

## 验收：三条主线一把跑

```bash
cd backend && .venv/bin/python scripts/demo.py
```

覆盖：**S1 请假**（或签 → 条件分支 → 并行 fork/join → 脚本 → 结束）、**S2 合同**
（>50 万三方并签/一票否决；<50 万竞签）、**S4 报销**（同一张表单 5 个节点权限不同、
越权字段丢弃、必填校验），以及幂等、退回重提、试跑不落库、越权 403。

## 测试

```bash
# 需要一个**一次性库**（会被 drop_all/create_all 清空）
createdb pipewise_test
cd backend
TEST_DATABASE_URL="postgresql+psycopg://postgres@127.0.0.1:5432/pipewise_test" .venv/bin/pytest -q
```

48 个用例：表达式白名单、快照校验、脚本沙箱（超时/禁 import/异常）、引擎（令牌/网关/签核/
退回/挂起/幂等/步数保护）、表单权限矩阵、以及 HTTP 接口层。

## 目录结构

```
backend/
  app/
    main.py            FastAPI 入口（建表 + dispatcher + 静态页）
    middleware.py      请求级事务：响应发出**之前**提交
    models.py          wf_* 数据模型（PRD §16）
    seed.py            组织/表单/三个演示流程
    engine/
      engine.py        令牌驱动的执行引擎（advance/fire/签核/生命周期）
      graph.py         快照读取 + 发布前校验（PRD §5.5）
      expr.py          受限表达式（AST 白名单，不用 eval）
      script.py        Python 沙箱执行器（子进程 + rlimit + 白名单）
      sandbox_runner.py 沙箱执行体（只依赖标准库）
      context.py       上下文变量 + 乐观锁 + 审计
      assignee.py      审批人解析器
      forms.py         表单 Schema / 字段权限矩阵 / 三层校验
      publishing.py    版本快照与发布
      outbox.py        Webhook 事件投递（HMAC 签名 + 退避）
      dispatcher.py    崩溃续跑 / outbox / join 卡点巡检
    api/               REST 接口（definitions/forms/instances/tasks/admin/misc）
  static/              无构建 SPA（设计器 / 待办 / 实例 / 运维）
  tests/               pytest（引擎 + API）
  scripts/demo.py      端到端验收脚本
docs/tech-design.md    技术方案
index.html             PRD v1.1
```

## MVP 覆盖 vs P1/P2

已交付（PRD 标记 MVP 的 FR）：建模与设计器、发布与版本管理、实例生命周期、审批与任务、
三种签核、排他/并行网关、流程上下文、节点脚本沙箱、表单引擎（Schema/字段权限矩阵/三层校验）、
Web 端 Schema 驱动渲染、组织解析器、开放 API（幂等 + Webhook Outbox）。

**未做（明确留到 P1/P2，详见技术方案 §11）**：服务节点/MQ、定时与超时策略、通知渠道、
子流程/包容网关/抄送、表单高级能力（子表单/联动/计算/草稿/模板库）、多端（飞书 H5）、
多租户、长跑实例迁移、发布灰度、SSO。**重提语义 MVP 固定为「全部重走」**。

## 本地查看 PRD

浏览器直接打开 `index.html` 即可，无外部依赖。
