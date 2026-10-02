# 数据合同 v1 → v2 迁移说明

## 背景

一次直播投票后，短剧团队临时删除了人物支线，随后出现三类信任问题：

1. 付费观众质疑高声量来自刷票；
2. 网文作者把评论区讨论误当成续篇承诺；
3. 编辑部需要证明“观众反馈究竟如何进入创作”。

v1 只确认最小标识，无法回答这些问题。v2 不改变 v1 的任何既有标识与时间含义，
在其上增加**规则冻结、版本关联、处理依据、追加式留痕**四类结构。

## 不变的部分

- `schema_version` / `record_id` 仍是必要标识；
- `domain === 'feedback_proof'` 含义不变；
- `revision` 仍是记录内修订序号，**迁移本身不增加 revision**；
- `occurred_at` 语义不变。

读取方若只依赖以上字段，从 v1 切到 v2 无需改动（`loadRecord` 行为保持原样）。

## v2 新增结构

```
record
├─ identity_merges[]      跨平台账号合并（凭证、canonical 账号、合并时间）
├─ activities[]
│  ├─ rules_snapshot      开始前冻结：资格/权重/开始与截止/不可让渡边界
│  ├─ votes[]             票（权重来自冻结快照；withdrawn/refunded 留痕）
│  ├─ comment_threads[]   评论主题，可关联 content_version_id；评论带意见指纹
│  ├─ creator_responses[] 创作者回应（讨论，不构成承诺）
│  ├─ anomaly_flags[]     协同/搬运/多账号异常：证据 + 处置 + 受影响引用
│  ├─ late_arrivals[]     迟到数据：隔离，或仅允许进入主题归纳
│  ├─ tally_snapshots[]   计票快照：raw 与 adjusted，只能追加
│  ├─ decisions[]         创作决定：adopted/partially_adopted/rejected + 理由
│  └─ pledges[]           对订阅者的正式承诺：追加式状态历史 + 履行凭证
├─ content_versions[]     章节/镜头版本（draft/published，新版本 supersedes 旧版本）
├─ private_drafts[]       私人草稿（allowed_editors 显式授权）
└─ reward_settlements[]   奖励结算（意见指纹全局唯一支付）
```

## 核心规则如何被结构保证

| 要求 | 保证方式 |
| --- | --- |
| 资格/权重/截止/边界在开始前固定 | `rules_snapshot.frozen_at <= scheduled_start_at`，冻结后无任何修改入口；快照内另存开始与截止时间，顶层被篡改即校验失败 |
| 编辑不可让渡的边界 | `editor_non_delegable` 必填；合同写死 `can_audience_veto=false`、`heat_is_command=false`，无法通过配置放开 |
| 跨平台合并留依据 | 合并必须列出 ≥2 个账号、canonical 账号与凭证 `basis`；重复票以 `merge_id` 留痕后撤票 |
| 撤票/退款 | 状态单向 `counted → withdrawn/refunded`；退款必须有 `refund_id`；二者不进任何计票 |
| 异常协同行为 | `anomaly_flags` 必须有证据、处置理由；`excluded` 必须列出受影响的 `vote:*`/`comment:*` 引用 |
| 迟到数据 | 晚于截止的票**无法**写入 `votes`；只能进 `late_arrivals`，隔离或“仅主题可用”，永不影响票数 |
| 重算不改历史 | 快照只能追加（`supersedes_snapshot` 指向前序）；已 `published` 的内容版本没有任何修改入口 |
| 热度不是创作命令 | tally 与内容之间唯一的桥是人工 `decisions[]`：必须有 `decided_by`、`rationale`，并钉住某个快照 |
| 变化可追溯 | `traceContentChange(version_id)` 返回该版本依据的活动、决定、快照（raw/adjusted）与排名 |
| 讨论 ≠ 承诺 | 评论与直播发言只是 `comment_threads`/`creator_responses`；只有 `pledges[]` 是承诺，状态历史追加、履行需凭证 |
| 私人草稿 | `readPrivateDraft` 对非 `allowed_editors` 抛错；公开承诺视图不含任何草稿字段 |
| 同一意见只计酬一次 | 评论保存归一化意见指纹；同一指纹全局只能有一笔 `paid`，多入口在 `source_refs` 合并列明；`previewSettlements` 提供结算前去重预检 |

## 迁移方式

- 代码路径：`migrate(record)`（`src/contracts.js`）。目前唯一路径是 1 → 2。
- v1 记录没有互动负载，迁移只补空容器，不编造规则、反馈或决定。
- 高于当前支持版本的记录直接拒绝，避免静默降级。
- 业务样例由 `scripts/generate_sample.mjs` 通过公开 API 生成并通过完整校验，
  其 `revision` 从 1 调到 2，表示样例内容的第二次修订（与合同迁移无关）。
