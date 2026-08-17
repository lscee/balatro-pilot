# Reward v7 奖励机制

> 本文记录仓库当前实现：Semantic Policy v6、Reward v7。代码真值位于 [`src/semantic-experience.mjs`](../src/semantic-experience.mjs)、[`src/semantic-rag.mjs`](../src/semantic-rag.mjs) 与 [`src/semantic-prior.mjs`](../src/semantic-prior.mjs)。

Reward v7 不是训练模型权重。它把已确认的游戏 transition 保存为不可变轨迹，在终局后离线计算奖励标签，再通过 RAG 上下文和有界 semantic prior 影响下一次对**本地合法候选**的排序。

## 1. 版本与目标

| 项目 | 当前值 |
| --- | --- |
| Semantic Policy | `6` |
| Reward | `7` |
| 默认折扣 | `γ = 0.97` |
| 胜利语义 | Ante 8 原生胜利 checkpoint；默认胜后回菜单 |
| 原始数据 | 不覆写 |
| Reward 标签 | 按 `reward_version` 独立存储 |
| 模型权限 | 只能选择本地已生成的候选 |

主目标始终是赢下整局。Blind 推进、单手得分、现金和 Sticker 变化是稠密排序信号；它们不能把最终失败的轨迹变成正样本。

## 2. 记号

对一次已确认生效的 transition $s_t,a_t,s_{t+1}$：

- $A_t$：Ante；
- $R_t$：全局 Round 编号；
- $P_t=\operatorname{clip}(score_t/target_t,0,3)$：当前 Blind 的完成进度；代码字段名为 `pressure`；
- $H_t$：本次 `play` 实际新增的筹码；
- $M_t$：现金；
- $U_t$：所有 Rental Joker 的每 Blind 总维护费；
- $X_t$：本 transition 可安全归因的 Perishable 过期张数。

定义 $\operatorname{clip}(x,l,h)=\min(h,\max(l,x))$。

## 3. 即时奖励

即时奖励先累加，再裁剪到 `[-4, 6]` 并保留三位小数：

$$
r_t=\operatorname{round}_3\left(\operatorname{clip}
\left(r_{progress}+r_{hand}+r_{action}+r_{cash}+r_{rental}+r_{perishable},-4,6\right)\right)
$$

### 3.1 进度

$$
r_{progress}=1.25\max(0,A_{t+1}-A_t)+0.45\max(0,R_{t+1}-R_t)
$$

若动作前处于 `SELECTING_HAND`，再加入：

$$
1.5(P_{t+1}-P_t)
$$

若之后进入 `ROUND_EVAL` 或 `SHOP`，再加 `0.8`。Ante 与 Round 只奖励正向推进；状态回退不会制造负奖励。

### 3.2 单手得分

当 $H_t>0$：

$$
r_{hand}=\operatorname{clip}\left(0.18\left[\log_{10}(\max(100,H_t))-2\right],0,0.9\right)
$$

这是平滑的小信号，单手再高也最多贡献 `0.9`；整局最高单手分会在终局奖励中另行计算。

### 3.3 动作成本

| 动作 | 即时项 |
| --- | ---: |
| `discard` | `-0.025` |
| `skip` | `-0.35` |
| `reroll` | `-0.06` |
| `buy` | 无固定奖励 |

Reward v7 已移除旧版“购买即 `+0.05`”的无条件奖励。购买是否有价值由后续现金、Sticker、局面推进和终局结果体现。

### 3.4 现金与 Gold Sticker

只有前后原始快照都显式保存相关字段时才计算；旧数据缺字段时贡献 `0`，不会伪造变化。

现金：

$$
r_{cash}=\operatorname{clip}\left(0.035(M_{t+1}-M_t),-0.7,0.7\right)
$$

Rental 负债：

$$
r_{rental}=\operatorname{clip}\left(-0.1(U_{t+1}-U_t),-0.6,0.6\right)
$$

Gold Stake 的基础 Rental rate 为 `$3`，所以新增一张普通 Rental Joker 通常产生 `-0.3`，移除同等负债产生对应正值。

Perishable 过期：

$$
r_{perishable}=-0.65\min(3,X_t)
$$

当前状态显式保存 TTL，包括 `perishable:0`。迁移旧轨迹时，只有同一卡从明确的 `perishable:1` 跨到结算边界的零 TTL/旧式 debuff，才会被安全归因为过期；普通 Boss debuff 不计罚。

## 4. 高分 Bonus

令 $S$ 为整局实际观测到的最高**单手分数**：

$$
B(S)=1.25\max(0,\log_{10}S-3)
+0.75[S\ge10^4]
+1.5[S\ge10^5]
+3.5[S\ge10^6]
$$

$S=0$ 时 $B(S)=0$。里程碑值：

| 最高单手 | Bonus |
| ---: | ---: |
| `10,000` | `2.0` |
| `100,000` | `4.75` |
| `1,000,000` | `9.5` |

展示分级为 `developing`、`ten_thousand`、`hundred_thousand`、`million`；分级本身不改变公式。

## 5. 终局奖励

### 5.1 胜局

$$
T_{win}=10+0.3\min(12,Ante)+B(S)
$$

Ante 8 普通胜局的基础终局值为 `12.4`，再叠加高分 Bonus。

### 5.2 败局

定义未花现金惩罚和提前崩溃惩罚：

$$
U=\min(3,\max(0,money)/20)
$$

$$
E=0.75\max(0,5-Ante)
$$

则：

$$
T_{loss}=\min\left(-0.5,-10+0.3\min(12,Ante)+\min(8,B(S))-U-E\right)
$$

因此：

- 败局终局值永远不高于 `-0.5`；
- 更深 Ante 和高分只能让失败“没那么差”，不能把失败变成正例；
- 败局高分贡献封顶 `8`；
- 正现金的未花部分最多额外罚 `3`；
- Ante 1–4 会受到提前崩溃惩罚。

## 6. 胜负判定

Balatro 的 `won` 是历史字段，单独看到 `GAME_OVER && won=true` 不能证明这次 Ante 8 Boss 已通过。

运行时只接受以下证据：

- 默认胜后回菜单时，`ROUND_EVAL && won=true` 是原生胜利 checkpoint；
- `GAME_OVER` 只有本局此前已经观察到胜利 checkpoint 才记为胜；
- Endless 模式不会把仍在继续的胜利 overlay 当成终局。

迁移旧数据时，历史 `won` 还必须满足 `maxAnte > 8`，或最后状态明确为 `ROUND_EVAL && won=true && score >= target`。否则只在新 Reward 标签中纠正为 `lost`，不修改原 episode 元数据。

## 7. 回报传播

Reward v7 不使用简单的 $G_t=r_t+\gamma G_{t+1}$。稠密信号和不可消失的终局锚点分开传播。

从后向前计算局部未来值：

$$
L_t=\operatorname{clip}(0.12r_t+\gamma L_{t+1},-0.9,0.9)
$$

若轨迹有 $N>1$ 个 transition，第 $i$ 个动作的位置权重为：

$$
p_i=\frac{i}{N-1},\qquad w_i=0.5+0.5p_i
$$

单 transition 时 $w=1$。稠密项缩放：

$$
d=\begin{cases}0.18,& loss\\1,& win\end{cases}
$$

最终：

$$
G_i=T\cdot w_i+dL_i
$$

之后应用三层保护：

1. 败局 $G_i\le-0.05$；
2. 胜局 $G_i\ge+0.05$；
3. 最终裁剪至 `[-24, 30]` 并保留三位小数。

最早动作仍承受 50% 的终局成败，最后动作承受 100%。因此数百步长局不会因为 $\gamma^N$ 太小而“忘记最终失败”。

## 8. 数据、迁移与兼容性

SQLite 默认位于 `data/semantic-experience.sqlite`：

| 表 | 内容 |
| --- | --- |
| `semantic_episodes` | 对局及终局元数据 |
| `semantic_experiences` | 不可变原始 transition |
| `semantic_reward_labels` | 按 Reward 版本保存即时奖励与 return |
| `semantic_reward_migrations` | 公式签名、迁移统计与时间 |

兼容等级：

- `exact`：Policy v6 且真实包含 collection、appeared Jokers、Stake rules、Sticker economy 与 strategy 等安全字段；
- `semantic`：旧特征可规范化，但不能冒充精确状态；
- `incompatible`：状态不能安全规范化，不进入 RAG/prior。

旧中断段只有在 seed/deck/stake 相同、两小时内、Ante 大于 1、进度不倒退且构筑/指纹边界严格吻合时，才会与唯一后续终局段关联。关联后的 canonical group 只进行一次联合反向传播，并采用所有段中的最高单手分。

奖励签名、credit 归属或历史标签异常时全量重标；普通新增完成局只增量重标该 canonical group。任何迁移都不覆写原始轨迹。

## 9. 奖励如何影响决策

### 9.1 RAG 上下文

RAG 只读取已完成、兼容且拥有当前 Reward v7 标签的历史。它要求 screen 相同，并对已知 Stake/rule signature 做硬隔离。默认参数：

| 参数 | 值 |
| --- | ---: |
| hot window | `5000` |
| search budget | `15 ms` |
| minimum similarity | `0.72` |
| top K | `4` |
| max context | `1600` 字符 |

注入内容包括相似度、样本数、平均 return、正值率、胜负局数量、历史状态、run plan、action 与 next state，并明确标记为 advisory evidence。

### 9.2 全历史 Semantic Prior

Prior 按抽象 decision/action bucket 聚合，每个 canonical episode 在同一 bucket 中最多一票。历史 return 先归一化：

$$
x=\tanh(G/4)
$$

败局再强制 $x\le0$。按来源和相似度加权后：

$$
n_{eff}=\frac{(\sum w)^2}{\sum w^2}
$$

$$
radius=z\sqrt{\frac{\sigma_w^2+0.25}{n_{eff}}}
$$

默认 `z=1.28`。只有至少 3 个独立 episode、有效 episode 至少 2.25，且整个置信区间严格位于零的一侧时，才产生非零 signal。

候选的本地顺序先线性映射为 `1 → 0`，经验混合为：

$$
blend=\min(0.3,0.1\log_2(N+1))
$$

$$
priority'=priority+signal\cdot blend
$$

Prior 只能重排 solver 已经生成的候选，不能创建动作、修改 RPC 参数、跳过 validator 或绕过 strategic approval。

## 10. 当前执行边界

- `semanticFastPathEnabled` 默认是 `false`；当前主 Runner 也不调用自动重放入口，因此历史不会直接绕过 planner 执行动作。
- 只有 RPC 前后状态明确变化的动作才写入 transition。
- dry-run、RPC 拒绝、无法确认的超时、stale plan、无可靠后续终局的中断段不会成为有效经验。
- 查看奖励完整性和先验覆盖率使用 `npm run learning:report`；该命令只读数据库，不启动游戏，也不调用付费模型。

## 11. 维护约束

修改奖励时必须：

1. 递增 `SEMANTIC_REWARD_VERSION`；
2. 更新 `rewardSignature`；
3. 为新公式添加单元测试；
4. 保证旧 transition 不被修改；
5. 验证胜局 return 始终为正、败局 return 始终为负；
6. 验证 migration 二次执行幂等，新增局只增量重标相关 canonical group。

修改语义状态合同则递增 `SEMANTIC_POLICY_VERSION`；旧数据只能降级为 semantic，不能通过补默认值伪装成 exact。
