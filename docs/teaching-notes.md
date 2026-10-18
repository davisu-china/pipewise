# PipeWise 实现精讲：技术难点与设计亮点（教学版）

> 面向对象：有 Python / SQL / 前端基础，但没做过工作流引擎的学生或初中级工程师。
> 目标：不是讲"这个项目有什么功能"，而是讲**为什么这样设计、难点在哪里、如果换一种做法会坏在哪里**。
> 配合代码阅读：所有结论都能在仓库里找到对应实现，文末附关键文件索引。

---

## 0. 怎样使用这份材料

建议 8 次课，每次 90 分钟，结构统一为：

1. **问题**：先抛一个会坏掉的朴素做法；
2. **推演**：它在什么场景下坏；
3. **方案**：本项目怎么解；
4. **代码**：带学生读关键函数；
5. **练习**：改一个约束，观察哪些测试挂了。

每节课的练习和思考题在第 10 节。

---

## 1. 全景：流程引擎到底难在哪

### 1.1 三个角色，三种视角

| 角色 | 关心什么 | 对应功能 |
|---|---|---|
| 流程设计师 | 图怎么画、条件怎么写、表单在哪个节点能改哪些字段 | 设计器、草稿、校验、发布 |
| 业务参与者 | 我的待办、我能填什么、同意/否决/转交/加签 | 待办、任务详情、发起 |
| 运维 / 管理员 | 卡在哪、为什么失败、能不能补救 | 实例详情、时间线、干预 |

流程引擎的本质不是"画图工具"，而是**一台可审计、可恢复、可并发的状态机**。图只是它的输入。

### 1.2 四条贯穿全项目的硬约束

这四条比任何功能都重要，后面所有设计都是在守它们：

1. **已发布版本不可变**：实例永远钉在创建时的 `version_id` 上，改流程不影响在跑的单子。
2. **一个请求 = 一个事务**：状态转移、变量写入、审计、事件入 Outbox 必须同生共死。
3. **人工节点是唯一的外部输入**：除人工任务和脚本外，流程推进是确定性的；同样的令牌状态推进出同样的结果。
4. **所有"用户可配置"的东西都不可信**：表达式、脚本、表单提交、字段权限，服务端必须重新校验。

### 1.3 技术栈与部署拓扑

```
浏览器
  │  HTTPS + Basic Auth
  ▼
nginx（容器 jianjian-nginx）
  ├── /pipewise/            → 静态托管 web/dist（React + shadcn/ui）
  └── /pipewise/api/        → 反代 172.17.0.1:8121（去掉前缀）
                                      │
                                      ▼
                         FastAPI（systemd，只提供 /api/v1）
                                      │
                                      ▼
                         PostgreSQL（pipewise_prod）

开发时：Vite dev server（5173）代理 /api 到本机 API
```

前后端分离后的两个细节，后面第 8 节展开：

- 前端构建的 `base` 是 `/pipewise/`，路由用 BrowserRouter 的 basename；
- 后端**不再挂静态文件**，`GET /` 返回 404，这是"分离"是否彻底的试金石。

### 1.4 数据模型：先看骨架

```
wf_definition（定义，含可编辑草稿 draft_json）
    └── wf_version（版本快照，发布后不可变）
            ├── wf_form_binding（节点 × 表单版本 × 字段权限，物化）
            └── wf_instance（实例，钉 version_id）
                    ├── wf_token（执行游标：ACTIVE / WAITING / CONSUMED）
                    ├── wf_node_instance（每次节点激活一条，含 activation_seq）
                    │       └── wf_task（人工任务，一个处理人一条）
                    ├── wf_variable（流程级变量，node_instance_id=0）
                    ├── wf_variable_log（每次变量变更的审计）
                    ├── wf_form_data（每次表单提交的原始数据）
                    ├── wf_audit_log（行为时间线）
                    └── wf_event_outbox（领域事件，事务内落库）
```

组织与表单是独立资产：`wf_user / wf_dept`、`wf_form / wf_form_version`。
`wf_idempotency` 存幂等键与首次响应，`wf_webhook` 存订阅，`wf_timer` 是 P1 预留。

> **课堂提问**：为什么实例表里同时存 `definition_id` 和 `version_id`？只存 `definition_id` 行不行？
> （提示：定义是逻辑身份，版本是执行语义；只存定义会在"发布新版本后老实例怎么跑"上失守。）

---

## 2. 难点一：执行模型——为什么不能用 status 字段表示"当前节点"

### 2.1 朴素做法与它的死法

最容易想到的实现：实例表加一个 `current_node` 字段，审批通过就改成下一个节点。

它在三个场景立刻坏掉：

1. **并行分叉**：一条审批同时流向 HR 和总监，"当前节点"变成两个值；
2. **会签**：同一节点有 3 个待办，任何一个完成都只是部分完成；
3. **循环**：同一个节点会被多次激活，`current_node` 无法表达"第几次"。

### 2.2 令牌模型：实例 = 一组令牌 + 一组待办

PipeWise 采用 BPMN 的令牌（token）语义：

- 一个**令牌**代表"执行流到了哪里"，有且只有一个 `node_id`；
- 状态只有三种：`ACTIVE`（可推进）、`WAITING`（停在人工节点或 join）、`CONSUMED`（已消费）；
- 实例是否结束不靠某个字段，而靠 `_settle()` 判定：**没有 ACTIVE/WAITING 令牌，也没有未完成任务**。

```
创建实例：start 节点生成 1 个 ACTIVE 令牌
advance()：循环取最早的 ACTIVE 令牌 → fire(节点) → 产生后继令牌/任务/消费自己
            直到没有 ACTIVE 令牌
```

对应代码：`backend/app/engine/engine.py` 的 `create_instance()`、`advance()`、`fire()`。

### 2.3 推进算法：一个 while 循环就是全部"调度器"

```python
while True:
    token = 取最早的一个 ACTIVE 令牌
    if token is None: break
    inst.step_count += 1
    if inst.step_count > MAX_STEPS: 实例置 FAILED（疑似死循环）
    fire(token)
    if 实例状态 != RUNNING: break
_settle(inst)   # 没有活令牌也没有待办 → COMPLETED
```

三个值得讲的设计点：

1. **完全顺序推进**：一个实例在同一事务里只被一个线程推进，天然没有"两个执行线程同时改状态"的问题。
2. **自动节点与人工节点统一抽象**：人工节点只是把令牌置 `WAITING` 并创建任务；任务完成后再次 `advance()`，从同一个入口继续。
3. **两级保护**：`MAX_STEPS`（单次推进的令牌数）防死循环，`MAX_NODE_ACTIVATIONS`（同一节点历史激活次数）防"循环里无限建任务"。

### 2.4 fork / join：join 到底在等什么

`parallel_gateway` 有两种方向，代码里由 `gateway_direction()` 判定（显式配置优先，否则按出入边数推断）：

- **fork**：一个令牌进来，每个出边各生成一个令牌；
- **join**：每个入边来的令牌先 `WAITING`，**按入边集合计数**，所有入边都到齐才消费这些令牌并产出一条新令牌。

关键细节：令牌上存 `arrived_edge`，join 比较的是"已到达的边集合 ⊇ 期望的边集合"，**不是令牌数量**。

> **为什么不能按数量？** 如果一条分支产生两个令牌、另一条产生零个，按数量可能"凑够 2 个"却缺了正确的边。
> 按边计数才能表达"每条并行分支都到过一次"。
>
> 这也是发布校验里要求 join 至少两条入边、且只能一条出边的原因（`graph.py · validate_snapshot()`）。

### 2.5 排他网关与"默认边"

`exclusive_gateway` 按边的 `condition` 顺序求值，命中就走；条件为空或 `true` 视为默认边。

发布校验强制**必须存在默认边**（`E_XOR_DEFAULT`），否则运行时可能"所有条件都不命中"，实例只能失败。
这是一个典型的"把运行期不确定性前移到发布期"的设计。

### 2.6 学生误区

- ❌ "join 等所有分支的任务完成"——它等的是**令牌到达**，不是任务。
- ❌ "循环只要图能连上就行"——没有步数/激活次数保护，一个条件写错就能打爆数据库。
- ❌ "并行就是多线程"——并行是**数据上的多条令牌**，执行仍是单线程顺序推进。

---

## 3. 难点二：并发与一致性——双击、重复提交、并发审批

### 3.1 三层幂等，各管一件事

| 层 | 机制 | 解决的问题 |
|---|---|---|
| 业务唯一键 | `wf_instance(definition_id, business_key)` 唯一约束 | 同一张业务单据重复发起 |
| 请求幂等键 | `Idempotency-Key` + `wf_idempotency` 回放首次响应 | 网络重试、客户端重复提交 |
| 状态条件更新 | `UPDATE ... WHERE status IN ('CREATED','CLAIMED')` | 两个审批人/两次点击同时完成同一任务 |

代码位置：`api/deps.py · idempotent()`、`engine.py · create_instance()`、`engine.py · complete_task()`。

幂等表按 `(scope, key)` 唯一；同一键第二次请求直接返回第一次的 `response_json`，不重复执行副作用。

### 3.2 并发审批：悲观锁 + 条件更新

任务完成的核心写法（`engine.py · complete_task()`）：

```python
inst = lock_instance(session, task.instance_id)     # SELECT ... FOR UPDATE
# ... 校验任务归属、实例状态、表单 ...
res = session.execute(
    update(Task)
    .where(Task.id == task.id, Task.status.in_(("CREATED", "CLAIMED")))
    .values(status="COMPLETED", verdict=..., completed_at=...)
)
if res.rowcount == 0:
    raise conflict("TASK_ALREADY_DONE", "任务已经被处理过了")
```

两道保险：

- **实例行锁**：同一实例的推进串行化，避免两个分支同时改实例状态；
- **条件 UPDATE**：即使两个请求都拿到了任务对象，只有一个能把状态从 `CREATED` 改走，另一个 `rowcount=0` → 409。

注意参数顺序：先检查"任务是否已结束"，再检查"实例是否可操作"，这样错误码更准确——用户看到的是"任务已处理"，而不是含糊的"实例不可操作"。

### 3.3 签核裁决：三种模式其实是一张表

`engine.py · _decide()` 把裁决规则集中在一个函数里：

| 模式 | 一个同意 | 一个否决 | 何时终结 |
|---|---|---|---|
| 或签 any | 立即通过 | 不立即失败，等其他人"救" | 有人通过；或所有人都否决 |
| 并签 all | 记录，继续等 | 默认一票否决（`vetoOnReject`） | 无待办后按 `approveRatio` 判定 |
| 竞签 race | 立即通过 | 立即否决 | 第一个完成的裁决即是结论 |

并签还有一个 `approveRatio`（默认 1.0），支持"三分之二通过"这类规则。
加签（add-sign）只是往同一 `node_instance` 里插入新任务，天然参与同一裁决集合；唯一约束 `(node_instance_id, assignee)` 防重复加同一个人。

> **课堂讨论**：或签里"否决不立即终结"是产品选择还是技术限制？
> 两者都有：技术上允许后到者改变结果，产品上避免一个人误点就把单子打死。把这种取舍讲清楚，比背规则重要。

### 3.4 事务边界：最容易踩的框架坑

`backend/app/middleware.py` 用请求级中间件管理事务：

```python
response = await call_next(request)
if response.status_code < 400:
    session.commit()
else:
    session.rollback()
```

**为什么不用 FastAPI 常见的 `yield` 依赖来提交？**
因为 `yield` 依赖的清理代码在响应发送**之后**才执行。客户端收到 200 立刻再发一个查询，可能读到尚未提交的旧状态。这个项目真实踩过，所以把提交前移到响应发出之前。

这条经验值得反复讲：**事务边界不是"函数结束"，而是"客户端看到结果之前"**。

### 3.5 变量并发：乐观锁的三种冲突策略

`context.py · _update_with_version()` 用版本号做条件更新：

```sql
UPDATE wf_variable
SET value = :new, version = version + 1
WHERE id = :id AND version = :expected
```

`rowcount=0` 说明别人先写了。此时由调用方选择：

- `fail`（默认）：抛冲突，实例失败/挂起，人工介入；
- `retry`：读新版本再试一次，仍失败才报错；
- `last_write_wins`：管理员改变量时用，直接覆盖并记审计。

**为什么变量要版本号，实例却用行锁？** 因为变量写入可能来自脚本、表单、管理员三个入口，粒度细、冲突概率高；实例推进是低频且需要整体一致，行锁更简单。

---

## 4. 难点三：版本化——"改流程不能影响在跑的单子"

### 4.1 草稿与版本是两种东西

- `wf_definition.draft_json`：唯一可编辑的草稿，带 `draft_rev` 乐观锁；
- `wf_version.snapshot_json`：提交时深拷贝草稿 + 校验 + 自动布局，**之后永不修改**；
- 实例创建时写入 `version_id`，运行期只读这个快照。

保存草稿时带 `rev`，服务端不匹配就返回 `DRAFT_CONFLICT`——两个设计师同时改同一张图时，后保存的人会收到明确提示，而不是静默覆盖。

### 4.2 发布前校验：把错误挡在运行期之外

`graph.py · validate_snapshot()` 返回 `issues`，分 `error` / `warning`：

- 结构：唯一 start、至少一个 end、边引用存在、节点 id 不重复；
- 连通性：所有节点从 start 可达；不可达 → error，到不了 end → warning；
- 网关：排他网关必须有默认边；fork 不允许带条件；join 至少两条入边、只能一条出边；
- 并行嵌套深度 ≤ 3（DFS 计数，防止审计和可视化失控）；
- 表单：引用的表单必须已发布，字段权限只能引用真实字段；
- 表达式：语法必须通过白名单检查；引用未声明变量 → warning；
- 脚本：能 `compile()`，且必须定义 `run(...)`。

任何 `error` 阻断提交/发布。**warning 不阻断**，但会在设计器里显示——这是"严格但可解释"的平衡。

### 4.3 试跑：在会回滚的事务里真跑一遍

设计器里的"试跑"不是模拟器，而是**真的创建实例、真的推进引擎、最后整体回滚**（`api/definitions.py · dry_run()`）。

- 用独立 `SessionLocal`，`finally: session.rollback()`；
- 实例标记 `dry_run=True`，dispatcher 和列表接口都会排除它；
- 人工节点自动按"同意"处理，最多 200 步；
- 返回节点轨迹、变量、最终状态。

好处是：分支条件、脚本、表单权限全部走真实代码路径，不存在"模拟器和引擎行为不一致"的经典问题。

### 4.4 表单绑定为什么要物化

快照里已经有 `formRef + fieldPermissions`，但发布时还写一张 `wf_form_binding`：

```sql
wf_form_binding(version_id, node_id, form_version_id, field_permissions_json)
```

原因：快照是 JSON，查"哪些流程版本用了哪张表单的哪个版本"很别扭；物化表让运维查询和后续表单升级分析变简单。
**快照仍是权威**，物化表是派生数据——这个主从关系必须在文档和代码注释里写清楚，否则后人会改错地方。

---

## 5. 难点四：表单引擎——同一张表单，不同节点不同权限

### 5.1 需求：为什么不能"每个节点复制一张表单"

请假单在发起节点要填天数/事由，主管节点只能看并填意见，HR 节点要填备案号，总监节点只能看。
如果每个节点复制一张表单，改一个字段要改五处，且历史数据无法对齐。

PipeWise 的做法：**表单是独立资产，权限是节点上的数据**。

```
表单 Schema：字段定义（类型、校验、选项、默认值）
节点配置：  formRef + fieldPermissions: { 字段名: { access, required } }
最终权限：  access ∈ {editable, readonly, hidden}，未配置默认 readonly
```

### 5.2 服务端裁剪：隐藏字段根本不下发

`forms.py · build_form_payload()` 在返回表单前就过滤：

- `hidden` 字段**不出现在响应里**；
- `readonly` 字段带值但前端禁用；
- `required` 只有在 `editable` 时才有意义。

这条设计的价值：前端拿不到隐藏字段，连"误提交"的机会都没有。但**不能只靠这个**——攻击者可以绕过前端直接调 API。

### 5.3 三层校验与"静默丢弃"

`forms.py · validate_submission()` 的核心策略：

| 提交内容 | 处理 |
|---|---|
| 表单里不存在的字段 | 丢弃并记录 |
| `readonly` / `hidden` 字段且值被改 | **丢弃并记录，不报错** |
| `editable` 字段类型/范围/正则/选项不合法 | 返回结构化错误 |
| `editable + required` 为空 | 返回结构化错误 |
| 跨字段 `validate` 表达式失败 | 返回结构化错误 |

为什么越权写入是"丢弃"而不是"报错"？
因为前端可能因为版本差异带上了旧字段；报错会让用户无法提交，而丢弃 + 审计既安全又不阻塞。**错误提示给用户，越权证据给审计**。

三层指的是：前端即时提示（体验）→ 服务端裁剪与校验（安全）→ 引擎事务内写变量（一致性）。前两层都可以被绕过，第三层不能。

### 5.4 表单版本也钉在流程版本上

发布流程时，`formRef` 解析成当时的 `form_version_id` 并写入 `wf_form_binding`。
之后表单再发新版本，老流程实例仍用老表单——和流程快照是同一个思路：**执行语义必须可复现**。

---

## 6. 难点五：安全地执行"用户代码"——表达式与脚本双引擎

### 6.1 为什么需要两种

- **表达式**：边条件、字段校验，要求轻量、只读、可缓存、毫秒级；
- **脚本**：金额计算、复杂映射，要求能写逻辑，但绝不能拿到服务器权限。

把两者混在一起，要么表达式太重，要么脚本太危险。

### 6.2 表达式：不用 `eval`，自己解析 AST

`expr.py` 的流程：

```
源码 → ast.parse(mode="eval") → 递归检查每个节点是否在白名单 → 自己递归求值
```

白名单只允许：字面量、名字、一层属性（`ctx.x` / `local.x` / `env.x` / `task.x`）、下标、布尔/比较/四则/三元、白名单函数调用。

明确禁止（都有测试钉住）：

- `__import__`、`open` 等任意函数；
- 方法调用 `ctx.dept.strip()`；
- 属性链 `ctx.a.b.c`；
- lambda、推导式、赋值表达式、关键字参数。

两个工程细节：

1. **金额是 decimal 字符串**（`"680000.00"`），比较 `ctx.amount > 500000` 时会自动转数值，避免浮点误差和类型错误；
2. **编译结果带缓存**（按源码字符串），同一条件在循环里不会被反复 parse。

### 6.3 脚本沙箱：进程隔离 + 资源限制 + 能力白名单

`script.py` 用独立子进程跑脚本：

```python
subprocess.run(
    [sys.executable, "-I", "-S", "sandbox_runner.py"],
    input=json.dumps(payload).encode(),
    capture_output=True,
    timeout=timeout_ms / 1000,
    start_new_session=True,
)
```

`-I` 隔离模式、`-S` 不加载 site-packages，保证沙箱进程只依赖标准库。子进程里再加三层限制（`sandbox_runner.py`）：

```python
resource.setrlimit(RLIMIT_CPU,   (cpu_seconds, cpu_seconds + 1))
resource.setrlimit(RLIMIT_AS,    (memory_mb * 1024 * 1024, ...))
resource.setrlimit(RLIMIT_CORE,  (0, 0))
resource.setrlimit(RLIMIT_NOFILE,(64, 64))
```

能力白名单：

- 只能 import `json / math / re / datetime / decimal`；
- 内置函数只保留 `len / range / min / max / sum / str / int ...` 等安全集合；
- `env` 是只读快照，`ctx/local` 的写入先记在内存，结束后由父进程落库；
- 注入固定的 `now`，脚本读不到系统时间，保证同一输入可重放；
- 输出超过 1MB 直接判失败，防止内存/日志被撑爆。

失败处理不是"一失败就挂"：

1. 节点可配置 `retries`，父进程重试；
2. 仍失败且配置了 `onErrorEdge`，走错误分支；
3. 没配错误边，实例置 `FAILED`，管理员可在运维页"重试失败节点"。

> **必须讲清楚的一句话**：Python 里靠 `exec(code, {"__builtins__": {}})` 做沙箱是不安全的，逃逸手段太多。真正的隔离边界是**进程 + 内核资源限制 + 能力白名单**，不是"把内置函数藏起来"。

### 6.4 学生误区

- ❌ "表达式用 `eval` 加个黑名单就行"——黑名单永远漏，白名单才是正确方向。
- ❌ "沙箱就是把 `__builtins__` 清空"——没有进程隔离，一次内存爆炸就带走整个服务。
- ❌ "超时用 `signal.alarm` 就够"——C 扩展/死循环/子进程都可能绕过；父进程 `timeout` + `RLIMIT_CPU` 是双保险。

---

## 7. 难点六：事件、崩溃与恢复——Outbox + Dispatcher

### 7.1 为什么不能在业务代码里直接发 HTTP

如果"任务完成"事务里直接 `httpx.post(webhook)`：

- 对端超时 → 数据库事务被拖长甚至回滚；
- 事务提交成功但 HTTP 失败 → 事件丢失；
- HTTP 成功但事务回滚 → 对端收到一个不存在的业务事件。

### 7.2 Outbox：事件与状态同事务落库

`engine.py · _event()` 只做一件事：往 `wf_event_outbox` 插一行 `PENDING`。
真正的投递由后台 `outbox.py · deliver_once()` 完成：

- `SELECT ... FOR UPDATE SKIP LOCKED` 取待投递行，多实例部署也不会重复抢；
- 每个 Webhook 目标单独 POST，任一失败整行重试；
- HMAC-SHA256 签名：`X-PipeWise-Signature: t=<unix>,v1=<hex>`，签名内容是 `timestamp.body`，防重放；
- 退避序列 `[2, 8, 30, 120, 600]` 秒，超过次数进 `DEAD`（死信）；
- 没有订阅者时直接标记 `DELIVERED`，不制造无意义积压。

语义是 **at-least-once**：对端必须按 `event_id` 幂等。这一点要明确写进对外文档，不能暗示 exactly-once。

### 7.3 Dispatcher：每 2 秒做三件事

`dispatcher.py · sweep_once()`：

1. **续跑**：找出 `RUNNING` 实例里残留的 `ACTIVE` 令牌，调用 `advance()`。
   —— 正常请求内已经推进完了，这里兜底"进程在事务边界外崩溃"的极端情况；
2. **投递**：跑一轮 Outbox；
3. **卡点巡检**：`WAITING` 超过 30 分钟的令牌记 `join.stalled` 审计并产生事件，但**不自动跳过**。

第 3 点是重要的产品判断：join 卡住通常意味着流程设计有问题或上游分支失败，自动跳过会制造"看起来成功、实际漏审"的事故。系统应该报警，让人决定。

---

## 8. 前端：从"能跑"到"能讲清楚"

### 8.1 组件体系：为什么选 shadcn/ui

- 组件源码直接进仓库（`web/src/components/ui/`），没有黑盒依赖；
- Radix 负责可访问性和交互行为（对话框焦点、下拉键盘操作），Tailwind 负责样式；
- 设计器、表格、表单都能按同一套 token 组合，不需要自造一套设计系统。

### 8.2 Schema 驱动表单渲染

`components/form-fields.tsx` 只认服务端返回的字段描述：

```ts
field.type   // text / textarea / number / amount / date / switch / select / multi_select ...
field.access // editable / readonly / hidden —— 服务端按"节点 × 字段"算好
field.value  // 当前上下文值
```

**前端不判断权限**，只执行服务端给的 `access`。这是第 5 节服务端裁剪的配套设计：权限只有一个真相源。

### 8.3 设计器：一个 1300 行的"小型绘图应用"

`pages/Designer.tsx` 值得单独讲，因为它把几个前端基础能力串起来了：

1. **坐标变换**：拖拽时把鼠标的屏幕坐标转成 SVG 坐标，必须用
   `svg.getScreenCTM().inverse()`，否则页面缩放/滚动后节点会"飞"；
2. **指针捕获**：`setPointerCapture` 后，鼠标移出画布也能继续拖；
3. **状态更新**：快照是 JSON，改动用深拷贝 + 不可变替换触发 React 重渲染；
4. **连线模式**：两次点击选起点/终点，而不是拖拽连线——教学项目里更稳定，也更容易解释；
5. **贝塞尔连线**：根据两点相对位置计算控制点，箭头用 SVG marker；
6. **JSON 双向**：设计器与原始 JSON 可以互相切换，方便讲"界面只是快照的一种视图"。

### 8.4 一个真实线上 bug：令牌存了 state，没存 localStorage

部署后用户反馈"点了登录还是不行"。服务端日志显示：

```
GET /api/v1/dev/demo-users  200
GET /api/v1/me              401
GET /api/v1/definitions     401
```

根因不在后端，而在前端的状态一致性：

- `AuthProvider` 首次加载拿到演示账号列表，选中第一个账号，只调用了 `setTokenState(...)`；
- 而 `api.request()` 每次请求读的是 `localStorage.getItem("pipewise.token")`；
- 结果首屏所有请求带空令牌；手动切换用户会写 localStorage，所以现象是"时好时坏"。

修复是"选择默认账号时同步 `persistToken`"，并补了一个**严格的测试 mock**：除公开接口外，没带 `X-PipeWise-Token` 一律返回 401。
原来的 mock 对所有请求都返回 200，正好把这类 bug 掩盖了。

> 这是整个项目最适合讲给学生的一个案例：**两个"都合理"的设计（React state 与 localStorage）之间必须有单一真相源；测试 mock 过于宽松，比没有测试更危险。**

### 8.5 鉴权头的冲突

整站挂在 nginx Basic Auth 后面，`Authorization` 头被 Basic 占用。如果前端再往同一个头写 `Bearer`，会把 Basic 凭据冲掉，nginx 直接 401。
所以 Web 前端用专用头 `X-PipeWise-Token`，SDK/脚本继续用 `Authorization: Bearer`，后端两种都认（`api/deps.py · current_user()`）。

这类问题不是"写错代码"，而是**多个中间件共享同一个协议字段**造成的，排查时要先画出请求经过的每一层。

### 8.6 部署：子路径 SPA 的三个关键点

1. **构建 base**：`VITE_BASE=/pipewise/`，产物引用 `/pipewise/assets/...`；
2. **路由 basename**：`BrowserRouter basename="/pipewise"`，刷新深链不 404；
3. **缓存策略**：`index.html` 必须 `no-cache`；带内容哈希的 assets 可以 `immutable` 长缓存。

nginx 侧（`deploy/deploy.sh`）：

```nginx
location ^~ /pipewise/api/ { proxy_pass http://172.17.0.1:8121/api/; ... }
location ^~ /pipewise/     { root /usr/share/nginx/html; try_files $uri $uri/ /pipewise/index.html; }
```

两个环境坑，学生自己部署时几乎必踩：

- nginx 跑在容器里，只能看到 bind mount 的 `nginx/html`；前端产物必须放进这个目录，不能放宿主机任意路径；
- 本机全局 `NODE_ENV=production` 会让 `npm ci` 静默跳过 devDependencies，`tsc`/`vite` 都没了。部署脚本显式 `NODE_ENV=development npm ci --include=dev`，测试脚本显式 `NODE_ENV=test`。

---

## 9. 一次完整请求的代码走读

以 S1 请假流程、`leave_days=3` 为例，把"创建实例 → 主管审批 → 并行 → 结束"串起来。

### 9.1 发起

```
POST /api/v1/instances
```

1. `api/instances.py` 校验定义已发布、发起人角色；
2. `idempotent()` 查 `wf_idempotency`，无则执行；
3. `engine.create_instance()`：
   - 按 `variables` 声明做类型转换与必填校验；
   - 插入 `wf_instance`（`version_id` 钉住当前版本）；
   - `write_vars()` 写流程级变量并记 `wf_variable_log`；
   - 写 `instance.created` 审计与 Outbox；
   - 在 start 节点创建一个 ACTIVE 令牌，调用 `advance()`。
4. `advance()` 依次经过 start → mgr：mgr 是审批节点，令牌置 WAITING，创建一条任务给李四；
5. 请求中间件在响应前提交事务。

### 9.2 主管审批

```
POST /api/v1/tasks/{id}/submit-form
```

1. `complete_task()` 锁实例、校验任务归属与状态；
2. `validate_submission()` 按 mgr 节点的字段权限裁剪：
   - `leave_days` / `leave_reason` 只读，篡改会被丢弃；
   - `mgr_comment` 可编辑且必填；
3. 写变量、写 `wf_form_data`、写审计与 Outbox；
4. 条件 UPDATE 任务为 COMPLETED（双击第二次会 409）；
5. `_decide()`：或签，本次同意 → 通过；
6. `_advance_from_node()` 取出边：`ctx.leave_days > 2` 命中 fork；
7. `advance()`：fork 产生两条令牌 → hr、vp 各创建一个 WAITING 任务；
8. 请求提交。

### 9.3 并行汇聚

- 总监先批：vp 令牌到 join，join 发现只到了 vp 一条入边，标记 WAITING 返回；
- HR 后批：hr 令牌到 join，入边集合齐了，消费两条等待令牌，产生一条新令牌 → calc；
- calc 是脚本节点：沙箱计算 `allowance` / `leave_left`，写回流程变量；
- 到 end：令牌 CONSUMED；`_settle()` 发现无活令牌、无待办 → 实例 COMPLETED。

### 9.4 数据变化速查

| 时刻 | wf_token | wf_node_instance | wf_task | wf_instance.status |
|---|---|---|---|---|
| 发起后 | mgr WAITING | start COMPLETED / mgr WAITING | 李四 CREATED | RUNNING |
| 主管批后 | hr WAITING, vp WAITING | fork COMPLETED, hr/vp WAITING | 王芳/张伟 CREATED | RUNNING |
| 总监批后 | hr WAITING, join WAITING | vp COMPLETED, join WAITING | 王芳 CREATED | RUNNING |
| HR 批后 | calc ACTIVE→CONSUMED | join COMPLETED, calc COMPLETED | 全部 COMPLETED | COMPLETED |

这张表建议让学生自己推一遍，比看十页文档有效。

---

## 10. 教学设计：8 节课

### 第 1 课：需求、不变量与数据模型

- **讲**：三个角色、四条硬约束、表关系；
- **演示**：跑 `scripts/demo.py`，看三条主线；
- **练习**：画出 `wf_instance` 到 `wf_variable` 的关系，解释 `node_instance_id=0` 为什么不用 NULL；
- **思考**：如果要做多租户，哪些表需要加 `tenant_id`？唯一约束怎么改？

### 第 2 课：令牌引擎

- **讲**：ACTIVE/WAITING/CONSUMED、advance 循环、fire 分派；
- **演示**：在数据库里观察令牌变化；
- **练习**：实现一个"抄送节点"（不阻塞流程，只产生一条通知）；
- **思考**：为什么实例结束要 `_settle()` 判定，而不是在 end 节点直接置 COMPLETED？

### 第 3 课：网关、并行与签核

- **讲**：fork/join 按边计数、三种签核、加签；
- **演示**：S1 的并行分支；S2 的竞签/并签；
- **练习**：给并签加"至少 N 人通过"的规则（提示：`approveRatio`）；
- **思考**：race 模式下，第二个人的否决请求应该返回什么？

### 第 4 课：并发与事务

- **讲**：三层幂等、行锁、条件更新、请求级事务；
- **演示**：用脚本并发提交同一任务，观察 409；
- **练习**：构造"两个管理员同时改同一个变量"，实现 retry 策略；
- **思考**：如果把事务提交放在 `yield` 依赖里，客户端可能看到什么异常现象？

### 第 5 课：版本化与发布

- **讲**：草稿/版本/实例钉版本、发布校验、试跑回滚；
- **演示**：发布新版本后老实例仍按老版本跑；
- **练习**：给校验器加一条规则（例如"审批节点必须有表单或意见字段"）；
- **思考**：试跑为什么要用独立 Session？共享会话会怎样？

### 第 6 课：表单引擎

- **讲**：Schema、节点×字段矩阵、三层校验、越权丢弃；
- **演示**：用 curl 直接提交隐藏字段，看审计记录；
- **练习**：给表单加一个 `validate` 跨字段规则（结束日期 > 开始日期）；
- **思考**：为什么越权字段是丢弃而不是报错？两种策略的产品后果分别是什么？

### 第 7 课：表达式与脚本沙箱

- **讲**：AST 白名单、沙箱进程、rlimit、模块白名单；
- **演示**：故意写 `import os` / 死循环 / 大内存，看失败方式；
- **练习**：给表达式加一个安全的日期函数；
- **思考**：为什么 `eval` + 黑名单不可靠？如果允许脚本访问网络，会带来哪些风险？

### 第 8 课：事件、恢复与前端

- **讲**：Outbox、HMAC、退避、dispatcher、SPA 部署、真实登录 bug；
- **演示**：在运维页看 Outbox 和回调接收器；
- **练习**：给前端测试 mock 加一条"没有令牌必须 401"的断言；
- **思考**：at-least-once 意味着客户端要做什么？如果要求 exactly-once，代价是什么？

---

## 11. 学生常见误区清单

1. 用一个 `current_node` 字段表示流程位置（并行就崩）。
2. 认为 join 在等"任务完成"（实际等令牌到达，按入边计数）。
3. 在数据库事务里发 HTTP 或调用外部服务。
4. 用 `eval` + 黑名单做表达式/脚本安全。
5. 认为前端隐藏字段就是安全边界（服务端必须重新裁剪）。
6. 直接修改已发布快照，或在实例上"就地升级"流程。
7. 用 `sleep` 测超时，或只测 happy path。
8. 把事务提交放在响应之后（FastAPI `yield` 依赖的经典坑）。
9. 前端只在内存里存令牌，接口却从 localStorage 读（本项目真实 bug）。
10. 测试 mock 对一切请求返回 200，掩盖鉴权 bug。

---

## 12. 关键文件索引

| 主题 | 文件 / 函数 |
|---|---|
| 令牌推进 | `backend/app/engine/engine.py` · `advance()` / `fire()` / `_fire_join()` |
| 任务完成与签核 | `engine.py` · `complete_task()` / `_decide()` / `_apply_reject()` |
| 请求级事务 | `backend/app/middleware.py` |
| 变量与乐观锁 | `backend/app/engine/context.py` · `_update_with_version()` / `write_vars()` |
| 表单权限与校验 | `backend/app/engine/forms.py` · `build_form_payload()` / `validate_submission()` |
| 发布校验 | `backend/app/engine/graph.py` · `validate_snapshot()` |
| 版本发布 | `backend/app/engine/publishing.py` · `create_version()` |
| 表达式白名单 | `backend/app/engine/expr.py` · `compile_expr()` / `_check()` |
| 脚本沙箱 | `backend/app/engine/script.py` / `sandbox_runner.py` |
| 事件投递 | `backend/app/engine/outbox.py` · `deliver_once()` |
| 崩溃恢复 | `backend/app/engine/dispatcher.py` · `sweep_once()` |
| 审批人解析 | `backend/app/engine/assignee.py` · `resolve_assignees()` |
| 数据模型 | `backend/app/models.py` |
| API 鉴权/幂等 | `backend/app/api/deps.py` |
| 前端 API 与鉴权 | `web/src/lib/api.ts` / `web/src/lib/auth.tsx` |
| Schema 驱动表单 | `web/src/components/form-fields.tsx` |
| 设计器 | `web/src/pages/Designer.tsx` |
| 部署 | `deploy/deploy.sh` |
| 测试 | `backend/tests/`（49 个）、`web/src/test/pages.test.tsx`（9 个） |

---

## 附：技术亮点速览

| 亮点 | 一句话 | 难度 |
|---|---|---|
| 令牌模型 | 用令牌集合而不是状态字段表达并行/循环 | ★★★★ |
| 单事务推进 | 状态、变量、审计、事件同生共死 | ★★★ |
| join 按入边计数 | 用 `arrived_edge` 集合判定汇聚，而不是数量 | ★★★★ |
| 三层幂等 | 业务键 + Idempotency-Key + 条件 UPDATE | ★★★ |
| 签核裁决表 | any/all/race 收敛到一个纯函数 | ★★★ |
| 不可变快照 | 实例钉版本，发布不扰动在跑实例 | ★★★ |
| 表单权限矩阵 | 权限是数据、默认只读、越权静默丢弃 | ★★★★ |
| AST 白名单表达式 | 不用 `eval`，自己 parse + 求值 | ★★★★ |
| 进程级脚本沙箱 | `-I -S` + rlimit + 模块白名单 + 超时 | ★★★★★ |
| Outbox + HMAC | 事务内落事件、事务外投递、可重放 | ★★★★ |
| 试跑回滚 | 真跑一遍再回滚，验证分支与脚本 | ★★★ |
| SPA 子路径部署 | base + basename + 静态托管 + 缓存分级 | ★★★ |
