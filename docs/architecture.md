# Balatro Pilot 系统架构

> 当前基线：Semantic Policy v6、Reward v7、BalatroBot 1.5.2 patched runtime。默认目标是在 Ante 8 确认胜利后返回菜单，不进入 Endless。

![Balatro Pilot 当前架构](assets/balatro-pilot-architecture.svg)

这张图是组件与信任边界图，不是动作流程图。它强调谁拥有真值、谁只能提出建议、谁有权写入游戏，以及学习数据如何在不绕过安全边界的前提下影响下一次决策。

## 架构原则

1. **游戏状态只有一个真值来源。** Balatro、Lovely、Steamodded 与固定指纹的 BalatroBot Lua 端点共同构成游戏运行时；Node 控制器不凭截图猜测主要游戏状态。
2. **模型不拥有执行权。** 高频模型和战略模型只能选择本地已枚举的候选 ID，不能自行构造任意 JSON-RPC 参数。
3. **本地内核负责安全。** 规则引擎、求解器和 policy validator 对牌型、Boss、资金、槽位、Sticker、目标索引及战略审批做确定性校验。
4. **Runner 是唯一写者。** 每次执行前重新读取状态并比较 fingerprint；RPC 串行发送，结果必须用新状态对账，不确定结果不会盲目重放。
5. **经验只能校准候选。** Semantic RAG 提供上下文，decision prior 有界重排现有候选；两者都不能生成动作、跳过 validator 或绕过战略审批。
6. **原始轨迹不可变。** Reward 版本升级只新增离线标签，不覆写历史 transition。

## 组件地图

| 平面 | 组件 | 职责 | 主要实现 |
| --- | --- | --- | --- |
| 游戏运行时 | Balatro + Lovely + Steamodded + BalatroBot | 提供游戏真值、执行原生动作、公开 patched GameState | `assets/balatrobot-v1.5.2/*.lua` |
| 精确状态 | BalatrobotClient / profile adapters | JSON-RPC 串行访问、状态适配、收藏与牌组目标 | [`src/balatrobot-client.mjs`](../src/balatrobot-client.mjs)、[`src/balatro-profile.mjs`](../src/balatro-profile.mjs) |
| 本地决策内核 | Rules Engine / Solver / Policy | 枚举有限合法候选，计算生存线、商店 NPV、Stake 与 Sticker 预算，验证最终参数 | [`src/balatro-rules-engine.mjs`](../src/balatro-rules-engine.mjs)、[`src/balatrobot-solver.mjs`](../src/balatrobot-solver.mjs)、[`src/balatrobot-policy.mjs`](../src/balatrobot-policy.mjs) |
| 编排与执行 | Balatrobot Runner | 读取状态、应用经验先验、调用模型、战略门禁、单写者执行与后置对账 | [`src/balatrobot-runner.mjs`](../src/balatrobot-runner.mjs) |
| 模型平面 | Routine / Strategic routers | 高频候选排序与关键构筑审批；支持 DeepSeek、Kimi、Ollama 路由 | [`src/models`](../src/models) |
| 经验平面 | SemanticRagStore / prior / Reward v7 | 保存轨迹、离线标注、相似经验检索、跨局有界先验 | [`src/semantic-rag.mjs`](../src/semantic-rag.mjs)、[`src/semantic-prior.mjs`](../src/semantic-prior.mjs)、[`src/semantic-experience.mjs`](../src/semantic-experience.mjs) |
| 运行控制 | Launcher / Watchdog / PilotControl | 受管启动、暂停标记、精确进程识别、AI 单独暂停与恢复 | [`scripts/run-balatro-pilot.ps1`](../scripts/run-balatro-pilot.ps1)、[`scripts/balatro-watchdog.ps1`](../scripts/balatro-watchdog.ps1)、[`src/pilot-control.mjs`](../src/pilot-control.mjs) |
| 可观测性 | RunLog / Dashboard / Overlay | 事件日志、组件健康、训练统计、后端切换与 OBS 视图 | [`src/dashboard-server.mjs`](../src/dashboard-server.mjs)、[`src/overlay-server.mjs`](../src/overlay-server.mjs) |

## 决策内核

### Exact State Envelope

进入内核的状态包含当前 hand、Joker、consumable、shop、pack、Blind、money、hands/discards、牌型等级以及累计 Stake 规则。Gold Stake 下还会保留 Eternal、Perishable TTL、Rental rate/upkeep、负现金和 Credit Card 可用额度。

状态 fingerprint 用于执行前新鲜度检查；`menu_ready` 与 `hand_actions_ready` 把原生 UI/状态机的短暂过渡隔离在规划之外。旧 Mod 缺失字段时采用显式兼容或 fail-closed，而不是猜测就绪。

### Candidate Fabric

- 规则引擎负责牌型、花色、Wild、Boss 限制和消耗牌目标契约。
- Solver 为 play、discard、buy、sell、reroll、pack、use、blind selection 等动作生成有限候选，并计算整轮生存与构筑价值。
- Policy 校验资金、槽位、索引、目标数量、卡牌身份、战略来源和 RPC 参数。
- Consumable memory 只按运行时 card ID 记录持有年龄；strategy checkpoint 只保存经过批准且仍可精确验证的续接动作。

### Single Writer

Runner 把模型选择重新绑定到当前候选，随后重新获取 fresh state。只有 fingerprint 未漂移且候选仍合法时才发送 RPC。执行后再次读取状态，确认分数、资源、阶段或对象身份发生了预期变化；超时或拒绝走隔离、退避、reconcile 或有界 circuit breaker。

## 模型边界

| 路由 | 适用场景 | 输出权限 |
| --- | --- | --- |
| `routine` | 常规出牌、弃牌、导航和普通候选排序 | 一个本地候选 ID |
| `strategic` | 商店构筑、购买/出售/重掷、Boss、破坏性消耗牌和关键生存决策 | 一个候选 ID，或与本地候选完全一致的结构化计划 |
| `local` | Ollama 本地高频排序 | 与 routine 相同 |
| `vision` | 旧视觉控制兼容与少量 UI 恢复 | 仍须经过本地动作 validator |

Provider、API Key 和协议只存在于 `src/models` 与配置层，不进入游戏规则。Dashboard 可热切换 routine 与 strategic 后端；切换会使健康缓存失效，但不会放松候选或 RPC 校验。

## 经验与奖励边界

每个确认成功的动作会写入原始 transition；完成局再由 Reward v7 生成独立标签。RAG 按相似局面向提示词注入正/负经验，decision prior 按抽象 decision/action bucket 聚合，每个独立 episode 最多一票，并使用置信区间决定是否应用。

经验混合最多只改变候选的本地排序，默认上限为 30%。精确 fast path 默认关闭，且当前主 Runner 不调用自动重放入口；历史不会绕过 planner。完整公式与迁移规则见 [Reward v7 奖励机制](reward-v7.md)。

## 运行与部署边界

- Mod/Lua 变更必须完整退出并重新启动 Balatro；只重启 Node 控制器不会热加载 Lua。
- Controller 可以单独暂停或重启，不应结束 Balatro、BalatroBot RPC、Dashboard、Overlay 或 Ollama。
- `watchdog` 只匹配本项目的受管 PowerShell/Node 入口，不使用进程树强杀游戏。
- 本地 `config.json`、`data/`、`runs/`、API Key 与 DPAPI 文件均不进入 Git。

## 本机端口

| 端口 | 服务 | 写权限 |
| --- | --- | --- |
| `12346` | BalatroBot JSON-RPC | 仅 Runner 经本地 validator 后写入 |
| `11434` | Ollama | 模型推理，无游戏写权限 |
| `4312` | Dashboard / Health / Pilot Control | 只控制 AI controller 与后端选择 |
| `4313` | OBS Overlay | 只读 |

## 维护入口

- 新增游戏能力：先扩 Lua GameState/endpoint，再扩 compact state、solver、policy 与测试。
- 新增模型供应商：只改 `src/models` 路由和配置，不触碰规则与 RPC 执行。
- 修改奖励：递增 Reward 版本、更新 reward signature，并通过离线迁移新增标签。
- 修改语义状态合同：递增 Policy 版本；旧数据只能降级为 semantic，不能伪装成 exact。
