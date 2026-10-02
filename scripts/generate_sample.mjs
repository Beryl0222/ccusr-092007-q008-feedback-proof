/**
 * 用 src 的业务 API 构造脱敏业务样例并写回 fixtures/audience_feedback.json。
 * 全程通过 validateV2 校验：能生成即说明样例满足当前合同。
 * 运行：node scripts/generate_sample.mjs
 */
import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate, validateV2, createActivity, freezeRules } from '../src/contracts.js';
import {
  addIdentityMerge,
  addVote,
  withdrawVote,
  refundVote,
  addCommentThread,
  addComment,
  addCreatorResponse,
  flagAnomaly,
  addLateArrival,
  computeTallySnapshot,
} from '../src/feedback.js';
import {
  addContentVersion,
  publishContentVersion,
  recordDecision,
  createPledge,
  transitionPledge,
  addPrivateDraft,
  settleReward,
} from '../src/editorial.js';

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, '..', 'fixtures', 'audience_feedback.json');

// 从 v1 样例迁移：保留既有标识与时间含义。
let rec = migrate({
  schema_version: 1,
  record_id: 'sample-008',
  domain: 'feedback_proof',
  occurred_at: '2026-09-20T09:00:00+08:00',
  revision: 1,
  source: '业务样例',
});
rec.revision = 2; // 记录本样例的第二次修订；v1→v2 迁移本身不动 revision。

// 内容版本：已发布版本不可变，变化只能以“新版本 supersedes 旧版本”的方式追加。
rec = addContentVersion(rec, { version_id: 'shot-ep07-v1', kind: 'shot', created_at: '2026-09-10T10:00:00+08:00' });
rec = publishContentVersion(rec, { version_id: 'shot-ep07-v1', published_at: '2026-09-12T20:00:00+08:00' });
rec = addContentVersion(rec, { version_id: 'shot-ep07-v2', kind: 'shot', created_at: '2026-09-19T22:50:00+08:00', supersedes: 'shot-ep07-v1' });
rec = publishContentVersion(rec, { version_id: 'shot-ep07-v2', published_at: '2026-09-20T12:00:00+08:00' });
rec = addContentVersion(rec, { version_id: 'shot-ep08-v1', kind: 'shot', created_at: '2026-09-22T09:30:00+08:00', supersedes: 'shot-ep07-v2' });
rec = publishContentVersion(rec, { version_id: 'shot-ep08-v1', published_at: '2026-09-28T20:00:00+08:00' });

// 直播投票：规则在开播前一天冻结。
const activity = createActivity({
  activity_id: 'live-20260919-ep07',
  title: '第7集「林晚支线」去留直播投票',
  scheduled_start_at: '2026-09-19T20:00:00+08:00',
  deadline_at: '2026-09-19T22:00:00+08:00',
  rules: {
    eligible_audience: ['paid_subscriber', 'single_ticket'],
    default_weight: 1,
    weight_overrides: { paid_subscriber: 2 },
    editor_non_delegable: ['最终剪辑与取舍决定权', '续集/续篇立项决定权', '主要人物生死与核心设定'],
    target_content_version_id: 'shot-ep07-v1',
  },
});
let frozen = freezeRules(activity, '2026-09-18T18:00:00+08:00');
rec = structuredClone(rec);
rec.activities.push(frozen);
rec = validateV2(rec);

// 跨平台账号合并：凭已验证绑定合并，禁止按设备指纹猜测。
rec = addIdentityMerge(rec, {
  merge_id: 'merge-001',
  account_refs: ['longtao:u_alice', 'duanju:u_alice_alt'],
  canonical_account: 'longtao:u_alice',
  merged_at: '2026-09-19T20:12:00+08:00',
  basis: '两账号提交了相同的已验证手机号绑定凭证',
});

// 真实投票。
rec = addVote(rec, { activity_id: 'live-20260919-ep07', vote_id: 'v-01', voter_account: 'longtao:u_alice', segment: 'paid_subscriber', option: 'keep_subplot', submitted_at: '2026-09-19T20:05:00+08:00' });
rec = addVote(rec, { activity_id: 'live-20260919-ep07', vote_id: 'v-02', voter_account: 'longtao:u_bob', segment: 'paid_subscriber', option: 'keep_subplot', submitted_at: '2026-09-19T20:08:00+08:00' });
rec = addVote(rec, { activity_id: 'live-20260919-ep07', vote_id: 'v-03', voter_account: 'duanju:u_carol', segment: 'single_ticket', option: 'keep_subplot', submitted_at: '2026-09-19T20:14:00+08:00' });
rec = addVote(rec, { activity_id: 'live-20260919-ep07', vote_id: 'v-04', voter_account: 'longtao:u_eric', segment: 'paid_subscriber', option: 'cut_subplot', submitted_at: '2026-09-19T20:20:00+08:00' });
rec = addVote(rec, { activity_id: 'live-20260919-ep07', vote_id: 'v-05', voter_account: 'duanju:u_fiona', segment: 'single_ticket', option: 'cut_subplot', submitted_at: '2026-09-19T20:22:00+08:00' });

// 合并账号的重复票：留痕后撤票，不计入任何结果。
rec = addVote(rec, { activity_id: 'live-20260919-ep07', vote_id: 'v-20', voter_account: 'duanju:u_alice_alt', segment: 'paid_subscriber', option: 'keep_subplot', submitted_at: '2026-09-19T20:10:00+08:00', merge_id: 'merge-001' });
rec = withdrawVote(rec, { activity_id: 'live-20260919-ep07', vote_id: 'v-20', withdrawn_at: '2026-09-19T20:13:00+08:00' });

// 退款用户：票排除并留退款单号。
rec = refundVote(rec, { activity_id: 'live-20260919-ep07', vote_id: 'v-05', refund_id: 'rf-20260919-7788', refunded_at: '2026-09-19T21:30:00+08:00' });

// 疑似协同刷票区块：8 张单场票在约两分钟内涌入，话术一致。
for (let i = 0; i < 8; i += 1) {
  const n = 10 + i;
  rec = addVote(rec, {
    activity_id: 'live-20260919-ep07',
    vote_id: `v-${n}`,
    voter_account: `duanju:u_brigade_${i}`,
    segment: 'single_ticket',
    option: 'cut_subplot',
    submitted_at: `2026-09-19T20:3${i % 2}:${String(10 + i * 7).slice(0, 2)}+08:00`,
  });
}

// 评论主题与具体版本关联。
rec = addCommentThread(rec, { activity_id: 'live-20260919-ep07', thread_id: 't-01', topic: '林晚支线的情感价值', content_version_id: 'shot-ep07-v1' });
const keepOpinion = '希望保留林晚支线，她和母亲的线很打动人';
rec = addComment(rec, { activity_id: 'live-20260919-ep07', thread_id: 't-01', comment_id: 'c-01', author_account: 'longtao:u_alice', text: keepOpinion, posted_at: '2026-09-19T20:31:00+08:00' });
rec = addComment(rec, { activity_id: 'live-20260919-ep07', thread_id: 't-01', comment_id: 'c-02', author_account: 'longtao:u_bob', text: '支线节奏偏慢，删掉也可以理解', posted_at: '2026-09-19T20:33:00+08:00' });
// 同一意见换个入口、措辞标点不同 → 指纹一致，计酬只算一次。
rec = addComment(rec, { activity_id: 'live-20260919-ep07', thread_id: 't-01', comment_id: 'c-03', author_account: 'longtao:u_gao', text: '希望保留林晚支线！她和母亲的线，很打动人。', posted_at: '2026-09-19T20:41:00+08:00' });

rec = addCommentThread(rec, { activity_id: 'live-20260919-ep07', thread_id: 't-02', topic: '续篇/第二季诉求' });
rec = addComment(rec, { activity_id: 'live-20260919-ep07', thread_id: 't-02', comment_id: 'c-10', author_account: 'duanju:u_reader9', text: '求第二季，求续篇官宣', posted_at: '2026-09-19T21:02:00+08:00' });

// 创作者回应：口头讨论明确不等于续篇承诺。
rec = addCreatorResponse(rec, { activity_id: 'live-20260919-ep07', response_id: 'r-01', author: '主编_赵', body: '直播结束后我们会复核票数来源，再决定第7集成片。', responded_at: '2026-09-19T21:20:00+08:00', addressed_vote_option: 'cut_subplot' });
rec = addCreatorResponse(rec, { activity_id: 'live-20260919-ep07', response_id: 'r-02', author: '网文作者_陆', body: '感谢期待续篇，但直播和评论区的讨论不代表立项；正式承诺会以编辑部公告为准。', responded_at: '2026-09-19T21:40:00+08:00', addressed_thread_ids: ['t-02'] });

// 异常协同行为：付费观众质疑后排查，判定排除并列出受影响对象。
rec = flagAnomaly(rec, {
  activity_id: 'live-20260919-ep07',
  flag_id: 'f-01',
  kind: 'coordinated',
  evidence: 'v-10…v-17 在 112 秒内从同注册批次账号投出，弹幕文本雷同，IP 段集中于同一 /24；付费观众于 09-20 上午集中投诉后复核确认',
  flagged_at: '2026-09-20T10:20:00+08:00',
  resolution: 'excluded',
  resolution_reason: '时间密度、注册批次与话术三类证据相互印证，按异常协同处理，排除其票与关联评论',
  affected_refs: ['vote:v-10', 'vote:v-11', 'vote:v-12', 'vote:v-13', 'vote:v-14', 'vote:v-15', 'vote:v-16', 'vote:v-17'],
});
// 跨平台合并的复核结论：重复票已撤，canonical 票保留。
rec = flagAnomaly(rec, {
  activity_id: 'live-20260919-ep07',
  flag_id: 'f-02',
  kind: 'multi_account',
  evidence: 'merge-001 两账号在直播中各投一票',
  flagged_at: '2026-09-19T20:15:00+08:00',
  resolution: 'retained',
  resolution_reason: '合并凭证有效，重复票 v-20 已撤，保留 canonical 账号票 v-01',
  merge_id: 'merge-001',
});

// 迟到数据：一律不进票。一批隔离；一条迟到评论仅可用于主题归纳。
rec = addLateArrival(rec, {
  activity_id: 'live-20260919-ep07',
  late_id: 'l-01',
  kind: 'vote',
  payload: { option: 'cut_subplot', count: 40, channel: '第三方渠道回传' },
  observed_at: '2026-09-19T22:43:00+08:00',
  disposition: 'quarantined',
  basis: '超过截止时间 43 分钟到达，且注册批次与 f-01 相同，任何计票快照都不得纳入',
});
rec = addLateArrival(rec, {
  activity_id: 'live-20260919-ep07',
  late_id: 'l-02',
  kind: 'comment',
  payload: { author_account: 'duanju:u_helen', text: keepOpinion },
  observed_at: '2026-09-19T23:10:00+08:00',
  disposition: 'accepted_for_themes_only',
  basis: '迟到评论不影响任何票数，仅允许进入评论主题归纳',
});

// 计票快照（只追加）：先有原始结果，排查后重算出排除异常结果。
rec = computeTallySnapshot(rec, { activity_id: 'live-20260919-ep07', snapshot_id: 's-raw-20260919', computed_at: '2026-09-19T22:05:00+08:00', kind: 'raw' });
rec = computeTallySnapshot(rec, { activity_id: 'live-20260919-ep07', snapshot_id: 's-adj-20260920', computed_at: '2026-09-20T11:00:00+08:00', kind: 'adjusted', excluded_flag_ids: ['f-01'], supersedes_snapshot: 's-raw-20260919' });

// 创作决定：热度不自动生成命令，每条变化都由人作出、写明理由并钉住某版计票结果。
rec = recordDecision(rec, {
  activity_id: 'live-20260919-ep07',
  decision_id: 'd-01',
  content_version_id: 'shot-ep07-v2',
  based_on_snapshot_id: 's-raw-20260919',
  outcome: 'partially_adopted',
  adopted_elements: ['删除林晚支线的主体戏份', '保留一个林晚镜头作为第8集钩子'],
  rationale: '直播当时只有截止时点的原始结果，删除声量加权领先；但规则明确观众无否决权。值班主编综合第7集时长超限人工决定：删主体、留钩子。刷票质疑在发布后才提出，故另立复核而非回改已发布成片。',
  decided_by: 'chief_zhao',
  decided_at: '2026-09-19T23:00:00+08:00',
});
rec = recordDecision(rec, {
  activity_id: 'live-20260919-ep07',
  decision_id: 'd-02',
  content_version_id: 'shot-ep08-v1',
  based_on_snapshot_id: 's-adj-20260920',
  outcome: 'adopted',
  rationale: '排除 f-01 协同票后保留方加权占优且排名翻转；结合对订阅者的正式承诺 p-01，在第8集恢复并收束林晚支线。',
  decided_by: 'chief_zhao',
  decided_at: '2026-09-22T10:00:00+08:00',
});

// 对订阅者的正式承诺：可核验状态与追加式历史，最终以已发布版本作为履行凭证。
rec = createPledge(rec, {
  activity_id: 'live-20260919-ep07',
  pledge_id: 'p-01',
  statement: '若异常排查改变投票结论，将在第8集恢复林晚支线并发布说明。',
  audience_scope: 'paid_subscriber',
  status: 'made',
  at: '2026-09-20T12:30:00+08:00',
  by: 'chief_zhao',
});
rec = transitionPledge(rec, { activity_id: 'live-20260919-ep07', pledge_id: 'p-01', status: 'in_progress', at: '2026-09-22T10:05:00+08:00', by: 'chief_zhao', note: '第8集剧本调整，恢复支线' });
rec = transitionPledge(rec, {
  activity_id: 'live-20260919-ep07',
  pledge_id: 'p-01',
  status: 'fulfilled',
  at: '2026-09-28T20:05:00+08:00',
  by: 'chief_zhao',
  note: '第8集上线，林晚支线恢复',
  verification: [{ type: 'published_version', version_id: 'shot-ep08-v1', url: 'https://example.invalid/ep08#linwan' }],
});

// 私人草稿：仅获准编辑可见。
rec = addPrivateDraft(rec, {
  draft_id: 'draft-01',
  owner: 'writer_lu',
  title: '续篇世界观草稿（内部）',
  body: '若续篇立项，林晚身世线与第8集钩子衔接……',
  created_at: '2026-09-25T14:00:00+08:00',
  allowed_editors: ['chief_zhao'],
});

// 奖励结算：同一意见在两个评论入口和一条迟到评论中出现，只计酬一次，入口全部列明。
rec = settleReward(rec, {
  settlement_id: 'st-01',
  opinion_text: keepOpinion,
  source_refs: ['comment:c-01', 'comment:c-03', 'late:l-02'],
  payee: 'longtao:u_alice',
  amount: 200,
  currency: 'CNY',
  status: 'paid',
  paid_at: '2026-09-30T18:00:00+08:00',
});

await writeFile(out, `${JSON.stringify(rec, null, 2)}\n`, 'utf8');
console.log(`wrote ${out}`);
