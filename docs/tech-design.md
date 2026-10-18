# PipeWise 技术方案 v1.0

> 对应 PRD v1.1（`index.html`）。PRD 定义**功能契约**，本文定义**实现契约**：数据模型、执行算法、
> 事务与幂等、API、表单协议、以及 MVP 与 PRD 的差异清单。
> 文中「PRD §x」指 PRD 章节，「本文 §x」指本方案章节。

---

## 0. 结论摘要

| 决策 | 选择 | 一句话理由 |
|---|---|---|
| 服务端 | Python 3.12 + FastAPI + SQLAlchemy 2.x | PRD 指定的 Python 栈；异步生态成熟 |
| 存储 | PostgreSQL 14 | 需要 `FOR UPDATE`、JSONB、事务 DDL；本机已有实例 |
| 执行模型 | **令牌 + 单事务状态机**（状态全落库） | 崩溃安全来自「事务提交/回滚」，不依赖内存态 |
| 执行内核 | MVP 用数据库事务 + 可替换的 `Executor` 抽象；**预留** Temporal/DBOS 接入点 | 见 §1.2：令牌模型与 workflow-as-code 的语义差异；MVP 必须单机可跑 |
| 前端 | 原生 JS SPA（SVG 设计器 + Schema 表单渲染），由 FastAPI 托管 | 零构建链，任何浏览器直接跑；避免为一个 MVP 引入前端工具链 |
| 鉴权 | Bearer token → 用户/RBAC（种子数据） | MVP 不做 SSO；接口已按服务身份设计 |
| 多租户 | 不做（PRD §14.6 P2）；所有核心表预留 `tenant` 列 | 不阻塞首个使用方 |
| 组织架构 | 本地 `wf_user/wf_dept` + 解析器 | PRD Q5：MVP 用本地缓存；接口留 `OrgProvider` 便于换实时组织服务 |

MVP 覆盖 PRD 中标记为 **MVP** 的 FR：FR-1/2/3/4/5/6/7/8/13/15/18/21(Web)。  
P1/P2 项（服务节点、定时/超时、通知、子流程、包容网关、长跑迁移、多租户、表单高级能力）
在实现中**留出结构**但明确不交付，见 §11。

---

## 1. 总体架构

### 1.1 分层

```
┌─────────────────────────────────────────────────────────────┐
│  接入层   REST /api/v1/*（Bearer）· Webhook(Outbox) · 静态 SPA │
├─────────────────────────────────────────────────────────────┤
│  编排层   Graph(快照) · Token · 签核 · 上下文 · 表单权限矩阵   │
│           Engine(advance) · Validator · Expr · Assignee      │
├─────────────────────────────────────────────────────────────┤
│  执行层   NodeExecutor(script/gateway/approval/form/…)        │
│           ScriptSandbox(子进程 + rlimit + 白名单)             │
├─────────────────────────────────────────────────────────────┤
│  存储层   PostgreSQL（唯一真相源）· Outbox 投递器              │
└─────────────────────────────────────────────────────────────┘
```

一次「创建实例」的调用路径：

```
POST /instances
  → 校验 definition/businessKey/变量
  → 事务开始：写 wf_instance + wf_token(start) + 审计 + outbox
  → Engine.advance()：同步推进所有可自动执行的节点，直到停在人工任务/结束
  → 事务提交
```

**要点：`advance` 在同一个事务里跑完**。所以「实例创建成功但第一个节点没激活」这种中间态不存在；
脚本节点抛错也不会留下半推进的图。

### 1.2 关于「执行内核不自研」（PRD 附录 A 的落地）

PRD 的结论是最终形态应嵌入 DBOS / Restate / Temporal。本文同意，但**MVP 不直接引入**，理由三条：

1. **语义错配**：durable execution 是「把一段函数变成可重放的工作流」；流程引擎是「把图上的令牌
   状态持久化」。人工任务会停留数天，真正的运行态是 `token/node_instance/task` 这些行，
   而不是某次函数调用栈。Temporal 里要用 signal + 长时间挂起的 workflow 模拟，反而增加心智负担。
2. **崩溃安全已经由 DB 事务提供**：引擎的每一次状态转移都是「一个事务内的多行改写」。
   事务未提交 = 没发生；提交 = 完成且幂等（§3.7）。调度器扫库续跑，就是最朴素的 durable execution。
3. **MVP 必须能单机一条命令跑起来**：引入 Temporal 集群会让评审、联调、验收的门槛成倍上升。

**预留接缝**（实现里已经留好）：

```python
class Executor(Protocol):
    def execute(self, session, node_instance, ctx) -> NodeResult: ...
```

脚本/服务节点未来接 Temporal/DBOS 时，把 `ScriptExecutor.execute` 换成
「投递到 durable runtime + 等待信号」，引擎其余部分不动。服务节点（P1）是这套抽象的第一受益者。

### 1.3 部署形态

```
单进程（MVP）：uvicorn app.main:app  ── PostgreSQL
    ├─ API 线程
    └─ 后台协程：dispatcher（续跑 ACTIVE 令牌 / 投递 outbox / 卡点巡检）
生产：API 多副本（无状态） + 独立 worker 副本（跑 dispatcher，任一副本持有 advisory lock）
```

**本机部署形态（`deploy/deploy.sh`）**：子路径 `https://jianjiange.site/pipewise/` →
共享 nginx（容器 `jianjian-nginx`）Basic Auth → `172.17.0.1:8121` → systemd `pipewise-api`
→ PG `pipewise_prod`（既有 5433 实例）。用子路径是因为独立域名的 DNS 还没配；
切独立域名只需换成 domain 模式的 server 块。

---

## 2. 数据模型

### 2.1 表清单（全部 `wf_` 前缀）

| 表 | 作用 | 关键约束/索引 |
|---|---|---|
| `wf_user` | 演示用用户/组织（MVP 简化） | `id` 文本主键；`token` 唯一 |
| `wf_dept` | 部门与负责人 | `leader_id → wf_user.id` |
| `wf_definition` | 流程定义稳定标识 | `key` 唯一；`current_version_id` |
| `wf_version` | 版本快照（不可变） | `unique(definition_id, version)`；`snapshot_json JSONB` |
| `wf_instance` | 实例 | `unique(definition_id, business_key)`；`(status, started_at)` 索引 |
| `wf_token` | 令牌（执行游标） | `(instance_id, status)`；`arrived_edge` 用于 join 计数 |
| `wf_node_instance` | 一次节点激活 | `(instance_id, node_id)`；`(instance_id, status)` |
| `wf_task` | 人工任务 | `(assignee, status)`；`unique(node_instance_id, assignee)` |
| `wf_variable` | 上下文变量 | `unique(instance_id, scope, node_instance_id, name)`；行内 `version` 乐观锁 |
| `wf_variable_log` | 变量审计 | `(instance_id, created_at)` |
| `wf_form` / `wf_form_version` | 表单资产与版本 | `key` 唯一；`unique(form_id, version)` |
| `wf_form_binding` | 节点 × 表单版本 × 字段权限 | `unique(version_id, node_id)` |
| `wf_form_data` | 表单提交数据 | `(instance_id)`；`indexed_json JSONB` |
| `wf_event_outbox` | 事件投递 | `(status, next_retry_at)` 索引 |
| `wf_audit_log` | append-only 审计 | `(instance_id, created_at)` |
| `wf_idempotency` | 写接口幂等 | `unique(scope, key)` |
| `wf_webhook` | 回调订阅 | `definition_key` 可空（全局） |

`wf_timer` / `wf_delegate` 属 P1（定时/超时/委托期），**建表但不使用**，见 §11。

### 2.2 状态枚举

```
instance.status : CREATED | RUNNING | SUSPENDED | COMPLETED | TERMINATED | FAILED
instance.outcome: completed | rejected | terminated        -- 终态时的结论
token.status    : ACTIVE | WAITING | CONSUMED
node_instance   : RUNNING | WAITING | COMPLETED | FAILED | CANCELLED
task.status     : CREATED | CLAIMED | COMPLETED | CANCELLED
task.verdict    : approve | reject | return | submit        -- submit 用于 form 节点
version.status  : DRAFT | SUBMITTED | PUBLISHED | RETIRED
```

### 2.3 不变量（代码里以约束 + 断言双重保证）

1. 一个实例任意时刻最多有一个活动令牌在**同一节点**被处理（靠实例级行锁串行化）。
2. 令牌 `token_id` 与 `node_instance.token_id` 一对一；节点激活后令牌转 WAITING。
3. 任务只能从 `CREATED|CLAIMED` 迁移到终态；`UPDATE … WHERE status IN (…)` 受影响行数为 0
   即视为重复提交（幂等）。
4. 已发布版本只读；实例永远读 `version_id → snapshot_json`。
5. 变量写入必须携带读到的 `version`；不匹配即冲突（§3.10）。

---

## 3. 执行引擎

### 3.1 令牌模型

- 实例启动：`wf_token(instance_id, node_id='start', status=ACTIVE)`。
- 令牌到达节点 → 创建 `wf_node_instance(activation_seq++)`，执行节点语义：
  - **自动节点**（start/script/gateway/end）：在本事务内算完，产出后继令牌；
  - **人工节点**（approval/form）：令牌转 `WAITING`，生成任务。
- 后继令牌：`Consume(current)` + `Create(next…)` 在同事务内完成。
- 实例结束：所有令牌 `CONSUMED` 且无 `WAITING/ACTIVE` → `COMPLETED`。

### 3.2 节点语义表

| 节点 | 输入 | 行为 | 输出 |
|---|---|---|---|
| start | 无 | 直接放行 | 1 条令牌 → 唯一出边 |
| end | 1 条 | 消费令牌；无剩余令牌则实例完成 | 无 |
| script | 1 条 | 沙箱执行 `run(ctx, local, env, logger, now)`；返回值写 local；`outputMapping` 指定写回 ctx 的键，**缺省时把返回的键直接写回流程级**（`ctx.set` 也直接写流程级） | 1 条令牌 → 唯一出边（或 `onErrorEdge`） |
| exclusive_gateway | 1 条 | 按出边**声明顺序**求值，取第一条 true；否则默认边 | 1 条令牌 |
| parallel_gateway(fork) | 1 条 | 忽略出边条件，每条出边各产 1 条令牌 | N 条令牌 |
| parallel_gateway(join) | N 条（按入边各 1） | 入边全部到齐后消费 N 条，产出 1 条 | 1 条令牌 |
| approval | 1 条 | 解析审批人 → 每个候选人一条任务；等裁决 | 通过/否决后 1 条令牌 |
| form | 1 条 | 解析填写人 → 任务；任一人提交即完成 | 1 条令牌 |

> 包容网关、服务、定时、等待、子流程、抄送：P1/P2，校验期直接拒绝（避免「配了但不生效」）。

### 3.3 推进算法

```python
def advance(session, instance_id, actor):
    inst = lock_instance(session, instance_id)          # SELECT … FOR UPDATE
    if inst.status in (COMPLETED, TERMINATED, FAILED): return
    if inst.status == SUSPENDED: return
    while True:
        token = pick_active_token(session, inst.id)      # ACTIVE，按 id 升序
        if token is None: break
        inst.step_count += 1
        if inst.step_count > MAX_STEPS:                  # 默认 1000
            fail_instance(inst, "step_limit"); return
        fire(session, inst, token, actor)                # §3.2；可能产生新 ACTIVE 令牌
        if inst.status != RUNNING: return
    settle(session, inst)                                # 判断是否到期完成
```

- `fire()` 内部对 `wf_node_instance` 与 `wf_token` 的更新都带状态条件（`WHERE status=…`），
  受影响行数为 0 时说明并发方已处理 → 重新取令牌。
- **一个 HTTP 请求 = 一个事务**：路由里的所有写入在**响应返回给客户端之前**提交
  （`app/middleware.py`）。不能用 FastAPI 的 yield 依赖来 commit——它的清理由响应发送之后才执行，
  客户端紧接着读会读到未提交的旧状态（本项目实测踩过）。
- 一次 HTTP 请求只推进到「下一个需要人/外部信号的点」为止；循环里出现新 ACTIVE 令牌就继续处理，
  所以并行 fork 后的多条分支会在同一个事务里都跑到各自的等待点。
- 每实例串行化：所有变更入口先 `SELECT … FOR UPDATE` 该实例行。实例之间互不影响，
  吞吐随实例数线性扩展（这也是 PRD §14.2 的口径）。

### 3.4 并行 fork/join

- **fork**：消费入令牌，对每条出边创建新令牌（`parent_token_id` 指回），全部 ACTIVE。
- **join**：到达的令牌**不建 node_instance**，只置 `WAITING` 并记录 `arrived_edge`。检查：
  ```sql
  SELECT count(DISTINCT arrived_edge) FROM wf_token
   WHERE instance_id=? AND node_id=? AND status='WAITING'
  ```
  等于 join 入边数 → 消费这些令牌，创建一个 `node_instance(join, COMPLETED)`（为了时间线），
  再产出一条 ACTIVE 令牌。
- **按入边计数**而不是按分支数：同一节点被回环重复进入时，每条入边每轮最多贡献一条令牌，
  天然按轮次归零。
- **嵌套**：内层 join 只认自己的入边，互不干扰。设计期限制嵌套 ≤ 3 层（校验器拒绝更深）。
- **死锁保护**：join 等待超过 `join_stall_minutes`（默认 30 分钟）的实例由巡检任务标记为
  `STUCK` 告警（写审计 + outbox 事件），**不自动跳过**（PRD §17-1）。

### 3.5 签核（或签 / 并签 / 竞签）

节点配置：

```json
{ "signMode": "any|all|race",
  "approveRatio": 1.0,        // all 模式：通过所需同意比例
  "vetoOnReject": true,       // all 模式：一票否决
  "rejectStrategy": "to_start|terminate",
  "assignee": { "type": "managerOf", "level": 1 } }
```

裁决表：

| 模式 | 收到 approve | 收到 reject | 节点结束条件 |
|---|---|---|---|
| any | 立即通过，回收其余任务 | 只记录意见，不结束 | 有人同意 → 通过；所有任务都终态且无人同意 → 否决 |
| all | 记录；达到 `approveRatio` 且无否决 → 通过（`vetoOnReject`） | `vetoOnReject=true` 立即否决并回收；否则记录，全员终态后按比例裁决 | 全部任务终态 |
| race | 第一个处理者定音 → 通过 | 第一个处理者定音 → 否决 | 第一个 verdict（同意或否决都算） |

- **加签**：往当前节点追加任务，纳入同一裁决集合；`race` 节点加签仍是先到先得（PRD §8.2）。
- **并发提交**：任务终态更新带 `WHERE status IN ('CREATED','CLAIMED')`；竞签第二个人提交时
  受影响行数为 0 → 返回 `409 TASK_ALREADY_DONE`，不重复流转（PRD §17-12）。

### 3.6 退回 / 撤回 / 终止 / 重提

| 动作 | 实现 |
|---|---|
| `rejectStrategy=terminate` | 实例 `COMPLETED`，`outcome=rejected`；回收全部令牌与任务 |
| `rejectStrategy=to_start` | 回收全部活动令牌与在途任务；给发起人建 `kind=resubmit` 的「重提单」任务（表单 = start 节点表单）；实例保持 `RUNNING` |
| 重提 | 发起人提交重提单 → 在 start 节点重新产出令牌 → 正常推进 |
| 撤回 | 发起人「首个人工任务被处理前」可撤回 → `TERMINATED`（`outcome=terminated`） |
| 终止 | 管理员/发起人 → `TERMINATED`；在途任务 `CANCELLED`，令牌 `CONSUMED` |
| 挂起/恢复 | 令牌与任务冻结（任务操作返回 `409 INSTANCE_SUSPENDED`） |

⚠️ **重提语义在 MVP 固定为 `restart`（全部重走）**：PRD §8.3 要求「保留已通过结果 or 全部重走」
二选一并显式配置。`resume`（跳过已通过节点）依赖路径级执行痕迹，和 P2 的实例迁移共用工具，
MVP 不实现；快照里可写 `resubmitMode: "restart"`，校验器只接受 `restart`。

### 3.7 幂等与并发

| 场景 | 机制 |
|---|---|
| 同一次 HTTP 重试 | `Idempotency-Key` + `wf_idempotency(scope,key)` 唯一；重复请求返回首次响应 |
| 同一任务双击/并发提交 | `UPDATE wf_task SET … WHERE id=? AND status IN (...)`；0 行 → 409 |
| 两个分支同时推进同一实例 | 实例行锁 `FOR UPDATE` 串行化 |
| dispatcher 与 API 同时推进 | 同上（dispatcher 也用实例行锁，且只推进 `ACTIVE` 令牌） |
| 重复创建实例 | `unique(definition_id, business_key)`；冲突返回已有实例（200，`deduplicated=true`） |

### 3.8 崩溃恢复与 dispatcher

- 后台协程每 2 秒扫一次：
  1. `wf_token.status='ACTIVE'` 的实例（正常情况下不会有——API 事务内会清空；异常退出时遗留）；
  2. `wf_event_outbox` 待投递；
  3. join 等待超阈值的卡点巡检。
- 扫到 ACTIVE 令牌 → `advance(instance)`（幂等）；进程崩溃后重启即自动续跑。
- 单副本用 `pg_try_advisory_lock(hash)` 防多 worker 重复扫描。

### 3.9 循环与步数保护

- `instance.step_count` 每次 `fire()` +1，超过 `MAX_STEPS=1000` → `FAILED`（原因 `step_limit`）。
- `node_instance.activation_seq` 针对同一 `(instance,node)` 计数，超过 100 → `FAILED`（`activation_limit`）。
- 图允许回环（校验器不禁止），保护在运行期。

### 3.10 上下文与并发写

- 流程级变量：`wf_variable(instance_id, scope='process', node_instance_id=0)`。
- 节点局部变量：`scope='local', node_instance_id=<id>`，节点结束即归档（不删除，留审计）。
- 写入协议：`UPDATE … SET value_json=?, version=version+1 WHERE … AND version=?`；0 行 →
  `VariableConflict`。按节点配置处理：`retry`（重读重算，仅脚本节点）/ `fail`（挂起 FAILED）/
  `last_write_wins`（记告警审计）。MVP 默认 `fail`，脚本节点默认 `retry` 一次。
- 每次写入落 `wf_variable_log`（旧值/新值/actor/节点），敏感变量的值在审计里脱敏为 `***`。
- 未声明变量：快照 `variables` 之外的名字默认**宽松允许**并写审计（PRD §10.2 可配，MVP 取宽松）。

### 3.11 表达式求值

- 用 Python `ast` 解析 + 白名单遍历，**不使用 `eval` 原语**：
  - 允许：`Name`（ctx/local/env 上的变量、`verdict`）、`Constant`、`Compare`、`BoolOp`、
    `BinOp(+ - * / % //)`、`UnaryOp(not/-)`、`Subscript`、`Attribute`（仅 `ctx.x` 形式）、
    `Call`（仅白名单函数）、`IfExp`、`In/NotIn`、三元与括号。
  - 禁止：赋值、lambda、推导式、属性链超过一层、任何未列入白名单的函数/方法。
- 内置函数：`len / contains / startswith / endswith / lower / upper / int / float / str /
  daysBetween / now / min / max / abs / round`。
- 求值上下文：`ctx`（流程级变量字典的只读视图）、`local`、`env`、`verdict`、`task`（当前任务只读信息）。
- 任何异常 → `EXPR_ERROR`，携带表达式原文与位置，实例按节点策略处理（网关默认 FAILED）。

### 3.12 脚本沙箱

- **独立子进程**：`python -I -S sandbox_runner.py`，通过 stdin 传 JSON、stdout 收 JSON。
- 资源限制（Linux `resource`）：CPU 3s、地址空间 256MB、无 core、`RLIMIT_NOFILE=64`；父进程另有
  墙钟超时（默认 3s，可配 300ms–10s）。
- 白名单：内置函数只保留安全子集（`abs/all/any/bool/dict/enumerate/float/format/int/len/list/
  max/min/range/reversed/round/set/sorted/str/sum/tuple/zip`）；`__import__` 只放行
  `json/datetime/decimal/math/re`；不注入 `open/eval/exec/compile/globals/locals/vars/dir/input`。
- 注入对象：`ctx`（get/set + 属性访问）、`local`（同）、`env`（只读）、`logger`（写回 stdout 日志）、
  `now()`（固定为本次执行的注入时间，保证可重放）、`user(id)`/`dept(id)`（只读查询，走父进程
  预取的快照，不在子进程连库）。
- 返回：`None` 或 `dict`（增量写 local）；非 dict → 错误。
- 说明：语言级白名单挡不住所有逃逸（例如通过异常的 traceback 对象），**生产环境应将
  runner 放进容器/gVisor，并加 seccomp 禁网**（见 §11 遗留）。

---

## 4. 表单引擎

### 4.1 表单 Schema

```json
{
  "key": "expense_form", "name": "费用报销单", "version": 1,
  "fields": [
    { "name": "amount", "label": "报销金额", "type": "amount", "required": true },
    { "name": "items", "label": "费用明细", "type": "textarea" },
    { "name": "supervisor_comment", "label": "主管意见", "type": "textarea" },
    { "name": "hr_no", "label": "HR 备案号", "type": "text" },
    { "name": "director_comment", "label": "总监批注", "type": "textarea" },
    { "name": "decision", "label": "审批结论", "type": "select",
      "options": [{"label":"同意","value":"approve"},{"label":"否决","value":"reject"}] }
  ]
}
```

- 字段类型（MVP）：`text / textarea / number / amount / date / datetime / switch / select /
  multi_select / rating / user / dept / file / static`（`static` 为说明文字，不产生变量）。
- `amount` 用 `decimal`（存储为字符串，避免浮点误差）。
- 布局类字段（group/section）P1：MVP 用 `static` + 字段顺序近似。

### 4.2 节点 × 字段权限矩阵

- 存储：`wf_form_binding(version_id, node_id, form_version_id, field_permissions_json)`。
- 结构：`{"amount": {"access": "editable|readonly|hidden", "required": true}, ...}`。
- **求值规则**：节点未配置的字段 → `readonly`（默认只读，PRD §10.2）；`required` 只在
  `editable` 时有意义。
- **渲染**：`GET /instances/{id}/form?node_instance=` 返回的 `fields` 已剔除 `hidden`，
  每个字段带 `access/required/value`；前端只做展示，**权限判断以服务端返回为准**。
- **提交**：服务端逐字段校验：
  1. `hidden/readonly` 字段若被提交了与原值不同的值 → **丢弃该写入并记审计**
     （PRD §17-20，不报错，防前端篡改）；
  2. `editable` + `required` 缺失 → 结构化错误（定位到字段）；
  3. 类型/正则/范围校验；
  4. 跨字段表达式校验（`validate` 字段上的表达式，MVP 支持）。
- 通过后：写变量（带 version）→ 写 `wf_form_data` → 完成任务 → `advance`，**同一事务**。

### 4.3 三层校验（PRD §10.6）

| 层 | MVP 实现 |
|---|---|
| 前端即时 | SPA 用 Schema 生成 `required/pattern/min/max`，失焦提示 |
| 服务端提交 | 上述 4 步，永远执行（前端可绕过） |
| 流转前 | 与提交校验同一入口；任务完成的唯一路径是 `submit-form`，因此不存在绕过 |

### 4.4 表单与上下文的双向绑定

- 字段名 = 变量名。提交写 `wf_variable`；脚本写变量后，下次 `GET form` 返回新值。
- 表单数据同时落 `wf_form_data`（归档、导出、检索用），变量表是**运行期唯一真相**。
- `indexed_json`：字段标记 `queryable: true` 时抽取到该列（MVP 只建 GIN，检索为 P1）。

---

## 5. 开放 API

统一前缀 `/api/v1`；写接口支持 `Idempotency-Key`。**两种凭证二选一**：

- `X-PipeWise-Token: <token>` —— Web 前端用。整站挂在 nginx Basic Auth 后面时 `Authorization`
  归 Basic 所有，SPA 若往同一个头写 Bearer 会把它冲掉（线上表现为「能过 Basic 登录，页面里每个接口都 401」）。
- `Authorization: Bearer <token>` —— SDK / 脚本 / 直连 API 用，保持兼容。
错误体：`{"error": {"code": "...", "message": "...", "details": {...}}}`。

| 方法 | 路径 | 说明 | 权限 |
|---|---|---|---|
| GET | `/me` | 当前用户 | 登录 |
| GET | `/users` | 用户列表（演示用） | 登录 |
| GET | `/definitions` | 定义列表（含当前版本） | 登录 |
| POST | `/definitions` | 新建定义（含草稿图） | designer |
| GET | `/definitions/{key}` | 定义 + 草稿 + 版本列表 | 登录 |
| PUT | `/definitions/{key}/draft` | 保存草稿图（乐观锁 `rev`） | designer |
| POST | `/definitions/{key}/validate` | 校验草稿（不落库） | designer |
| POST | `/definitions/{key}/dry-run` | 试跑（事务内跑完再回滚） | designer |
| POST | `/definitions/{key}/publish` | 直接发布（管理员） | admin |
| POST | `/definitions/{key}/submit` | 提交发布审批 | designer |
| POST | `/definitions/{key}/retire` | 下线（只拦新实例） | admin |
| GET | `/definitions/{key}/versions/{v}` | 版本快照 | 登录 |
| GET | `/definitions/{key}/form-schemas` | 已发布表单 schema（设计器用） | 登录 |
| GET | `/forms` / `POST /forms` / `PUT /forms/{key}/draft` | 表单设计 | designer |
| POST | `/forms/{key}/publish` | 发布表单版本 | admin |
| GET | `/instances` | 检索（状态/发起人/businessKey/分页） | 登录（见 §7） |
| POST | `/instances` | 创建并启动；`businessKey` 幂等 | 登录 |
| GET | `/instances/{id}` | 实例详情（当前节点、任务、时间线） | 参与人/管理员 |
| POST | `/instances/{id}/suspend` `/resume` `/terminate` | 生命周期 | 发起人/管理员 |
| POST | `/instances/{id}/withdraw` | 撤回（首个人工任务处理前） | 发起人 |
| GET | `/instances/{id}/timeline` | 审计 + 变量 + 任务合并时间线 | 参与人/管理员 |
| GET | `/instances/{id}/form?node_instance=` | 当前节点表单（已按权限过滤） | 任务参与人/管理员 |
| GET | `/tasks?assignee=me&status=pending` | 待办/已办 | 登录 |
| POST | `/tasks/{id}/claim` | 认领 | 候选人 |
| POST | `/tasks/{id}/complete` | 完成（`verdict=approve/reject`，无表单的任务） | 候选人 |
| GET | `/tasks/{id}/form` | 任务表单（已按节点权限过滤） | 候选人/管理员 |
| POST | `/tasks/{id}/submit-form` | 提交表单并完成任务（含 verdict） | 候选人 |
| POST | `/tasks/{id}/delegate` | 转交 | 候选人/管理员 |
| POST | `/tasks/{id}/add-sign` | 加签 | 候选人/管理员 |
| POST | `/tasks/{id}/remind` | 催办（写事件+审计） | 发起人/管理员 |
| POST | `/admin/instances/{id}/force-complete-task` | 强制完成任务 | admin |
| POST | `/admin/instances/{id}/set-variable` | 修改变量（审计） | admin |
| POST | `/admin/instances/{id}/retry` | 重跑 FAILED 的自动节点 | admin |
| GET | `/admin/outbox` | 事件投递记录 | admin |
| POST/GET | `/admin/webhooks` | 订阅管理 | admin |
| POST | `/dev/webhook-sink` | 本地回调接收器（演示） | 公开 |
| GET | `/dev/demo-users` | 演示用户与 token（**生产删除**） | 公开 |

**幂等**：`Idempotency-Key` 作用域为「创建/操作类写接口 + 当前用户」；同键重复直接回放响应。

**Webhook**：事件先落 outbox（同事务），投递器 POST JSON + `X-PipeWise-Signature:
HMAC-SHA256(secret, timestamp + "." + body)`，指数退避（2s/8s/30s/2m/10m），超限进死信。

---

## 6. Web 端

单页应用（`backend/static`），无构建步骤；hash 路由：

| 路由 | 页面 |
|---|---|
| `#/definitions` | 定义列表：名称/key/当前版本/状态/操作（设计/发布/下线） |
| `#/designer/{key}` | 设计器：SVG 画布 + 节点面板 + 配置抽屉 + 校验/试跑/JSON |
| `#/tasks` | 我的待办/已办；点开 → 表单页签 + 时间线 + 同意/否决/退回/转交/加签 |
| `#/instances` | 实例检索（管理员/发起人） |
| `#/instances/{id}` | 实例详情：状态、当前节点、任务、时间线 |
| `#/admin` | 运维：outbox、webhook、卡点巡检结果 |
| `#/forms` | 表单列表；MVP 用 **JSON 编辑**（可视化拖拽设计器为 P1） |
| 顶栏 | 用户切换（演示用，种子用户 token） |

设计器交互（MVP）：拖拽节点、点击两节点连线、选中节点/边改配置、自动布局、校验、保存、发布、
JSON 直接编辑、试跑（输入变量 → 路径轨迹）。撤销/重做、多人协同编辑属 P1。

---

## 7. 权限与组织（MVP）

- 用户表内置 `roles`（JSON 数组）：`admin / designer / developer / user`。
- 角色能力按 PRD §18 简化：`designer` 可建/改草稿、提交发布；`admin` 可发布/下线/干预/看全部；
  `initiator` 只能看自己的实例；`assignee` 只能看自己的任务与相关实例。
- 组织解析器：`user(id) / role(code) / managerOf(userId, level) / deptLeader(deptId) /
  initiator / expr(expression)`，全部查本地 `wf_user/wf_dept`；`ScriptResolver` 为 P1。
- 解析为空：默认**指派给管理员**并告警（PRD §8.5 默认策略），可在节点显式配 `emptyPolicy`。

---

## 8. 非功能

| 项 | MVP 做法 |
|---|---|
| 一致性 | 每个状态转移单事务；事件同事务入 outbox；幂等键见 §3.7 |
| 性能 | 实例级行锁（串行），实例间并行；关键索引见 §2.1；脚本 3s 上限 |
| 可观测 | 结构化日志带 `instance_id/task_id`；`/admin/stats` 返回状态分布/积压/卡点；审计表即 trace |
| 安全 | Bearer + 角色校验；任务操作校验归属；脚本沙箱；敏感变量脱敏 |
| 备份 | 数据库级（运维负责）；审计 append-only |

---

## 9. 测试与验收

`backend/tests`（pytest，独立测试库）：

1. **引擎单测**：令牌推进、XOR 默认边、并行 fork/join（含嵌套）、join 阻塞、阶段上限、
   步数上限、脚本报错走 onError、表达式白名单（拒绝属性链/调用）。
2. **签核**：any/any-all-reject/all(比例/一票否决)/race/加签/并发提交（一次生效）。
3. **上下文**：变量乐观锁冲突、审计落库、未知变量宽松写入。
4. **表单**：权限过滤、越权字段丢弃、必填/类型/跨字段校验、提交与流转同事务（失败不推进）。
5. **生命周期**：退回→重提、撤回、终止、挂起/恢复、幂等 businessKey、幂等键重放。
6. **端到端**：S1（请假：或签→XOR→并行→join→脚本→结束）、S2（合同：并签/竞签）、
   S4（同一表单 5 个节点权限不同）；dry-run 不落库。
7. **API**：鉴权、权限（越权 403）、错误码。

验收脚本：`backend/scripts/demo_s1.py` 等用真实 HTTP 走完三个场景（同时作为 README 的演示）。

---

## 10. 运行

```bash
cd backend
uv venv --python 3.12 .venv && uv pip install -r requirements.txt   # 或 uv sync
createdb pipewise  # 或 psql -c 'CREATE DATABASE pipewise'
export DATABASE_URL=postgresql+psycopg://mutual@127.0.0.1:5433/pipewise
.venv/bin/python -m app.seed          # 建表 + 种子（用户/部门/表单/三个流程）
.venv/bin/uvicorn app.main:app --host 0.0.0.0 --port 8100
# 浏览器打开 http://127.0.0.1:8100/
```

测试：`DATABASE_URL=... .venv/bin/pytest -q`（自动建/清独立 schema）。

---

## 11. 与 PRD 的差异 & 遗留（必须显式列出）

| 项 | PRD | MVP 实现 | 原因/后续 |
|---|---|---|---|
| 执行内核 | 倾向嵌入 DBOS/Restate/Temporal | 事务化令牌 + `Executor` 接缝 | §1.2；P1 接服务节点时落地 |
| 重提语义 | 保留已通过 or 全部重走（显式选） | 只支持 `restart`（全部重走） | `resume` 需路径痕迹，与 P2 迁移工具同批 |
| 退回指定节点/上一节点 | to_prev / to_node | 只支持 to_start / terminate | P1；to_node 需白名单 + 二次确认 |
| 委托（代理期） | 有 | 未做（仅单任务转交） | P1，`wf_delegate` 表已留 |
| 超时/定时/催办策略 | 提醒/自动通过/自动否决/自动转交 | 催办仅写事件；无定时器 | P1（`wf_timer` 表已留） |
| 通知 | 站内信/飞书/邮件 | 仅 Webhook 事件 | P1；接口按事件设计 |
| 服务/等待/子流程/包容网关/抄送 | P1 | 校验期拒绝 | 按 PRD 优先级 |
| 表单高级 | 子表单/联动/计算/数据源/草稿/模板 | 未做（Schema 预留 `children`） | P1，PRD 明确可后移 |
| 表单多端 | PC + 飞书 H5 | 响应式 Web（手机可用） | 飞书容器接入 P1 |
| 多租户 | P2 | 未做；表留 `tenant` 列 | 按 PRD |
| 长跑迁移 | P2 | 未做 | 按 PRD |
| 发布审批流 | 设计者提交→管理员审批→灰度 | 提交/发布两态，无灰度 | 灰度 P1 |
| 变量静态校验 | 阻断发布 | 警告级（脚本动态产出不可静态判定） | 见 §3.11 说明 |
| 脚本沙箱 | 独立进程 + 资源限制 + 白名单 | 已实现；**容器/seccomp 禁网留待生产** | §3.12 |
| 认证 | Token/服务身份 | Bearer + 种子用户（演示切换器） | SSO/OIDC P1 |
