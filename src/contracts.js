import { readFile } from 'node:fs/promises';

/**
 * 数据合同。
 *
 * v1 只确认最小标识（schema_version + record_id），既有读取方依赖
 * `domain === 'feedback_proof'` 与递增的 `revision`，这两个含义在后续版本保持不变。
 * v2 在此之上加入：互动规则冻结、反馈与内容版本关联、异常处理依据、
 * 追加式的计票快照/创作者决定/承诺/结算。
 *
 * 关键不可变原则（由结构而非约定保证）：
 * - 规则快照在互动开始前冻结，之后只读；
 * - 计票快照只能追加，重算永不覆盖旧快照；
 * - 已发布的章节/镜头版本不可被本系统任何流程修改，决定只“引用”版本；
 * - 热度（tally）不会自动改动内容，必须另有一条人工决定记录。
 */
export const CURRENT_SCHEMA_VERSION = 2;

export const RULE_STATUS = Object.freeze(['draft', 'frozen', 'closed']);
export const VOTE_STATUS = Object.freeze(['counted', 'withdrawn', 'refunded']);
export const COMMENT_STATUS = Object.freeze(['counted', 'excluded']);
export const LATE_DISPOSITION = Object.freeze(['accepted_for_themes_only', 'quarantined']);
export const FLAG_KINDS = Object.freeze(['coordinated', 'brigade', 'multi_account', 'cross_platform_merge', 'other']);
export const FLAG_RESOLUTION = Object.freeze(['excluded', 'retained', 'quarantined']);
export const DECISION_OUTCOMES = Object.freeze(['adopted', 'partially_adopted', 'rejected']);
export const PLEDGE_STATUS = Object.freeze(['proposed', 'made', 'in_progress', 'fulfilled', 'withdrawn']);
export const SETTLEMENT_STATUS = Object.freeze(['pending', 'paid', 'void']);

/** 读取项目已确认的最小数据合同：v1 行为保持不变。 */
export async function loadRecord(path) {
  const payload = JSON.parse(await readFile(path, 'utf8'));
  if (!Number.isInteger(payload.schema_version) || !payload.record_id) {
    throw new Error('数据合同缺少必要标识');
  }
  return Object.freeze(payload);
}

/** 读取并迁移到当前合同版本，校验通过后整体冻结。 */
export async function loadRecordV2(path) {
  const raw = JSON.parse(await readFile(path, 'utf8'));
  if (!Number.isInteger(raw.schema_version) || !raw.record_id) {
    throw new Error('数据合同缺少必要标识');
  }
  return validateV2(migrate(raw));
}

/**
 * v1 → v2 迁移：
 * - 保留 schema_version / record_id / domain / occurred_at / revision / source；
 * - v1 业务样例没有互动负载，给空容器即可，不替它编造规则或反馈；
 * - revision 含义（记录内修订序号）不变，迁移本身不增加 revision。
 */
export function migrate(record) {
  if (record.schema_version > CURRENT_SCHEMA_VERSION) {
    throw new Error(`schema_version=${record.schema_version} 高于当前支持版本 ${CURRENT_SCHEMA_VERSION}`);
  }
  if (record.schema_version === CURRENT_SCHEMA_VERSION) return structuredClone(record);
  return {
    schema_version: 2,
    record_id: record.record_id,
    domain: record.domain ?? 'feedback_proof',
    occurred_at: record.occurred_at,
    revision: record.revision,
    source: record.source,
    identity_merges: [],
    activities: [],
    content_versions: [],
    private_drafts: [],
    reward_settlements: [],
  };
}

/* ------------------------------------------------------------------ */
/* 校验                                                                */
/* ------------------------------------------------------------------ */

function requireString(obj, key, where) {
  if (typeof obj[key] !== 'string' || obj[key] === '') {
    throw new Error(`${where} 缺少字符串字段 ${key}`);
  }
}

function requireIso(value, where) {
  const ts = Date.parse(value);
  if (Number.isNaN(ts)) throw new Error(`${where} 的时间戳不是合法 ISO8601：${value}`);
  return ts;
}

function requireEnum(value, allowed, where) {
  if (!allowed.includes(value)) throw new Error(`${where} 的状态非法：${value}`);
}

function requireUniqueIds(list, idKey, where) {
  const seen = new Set();
  for (const item of list ?? []) {
    requireString(item, idKey, where);
    if (seen.has(item[idKey])) throw new Error(`${where} 存在重复标识 ${item[idKey]}`);
    seen.add(item[idKey]);
  }
}

/** 校验 v2 记录：时间线、引用完整性与“冻结/追加/不可变”的前置条件。 */
export function validateV2(record) {
  if (record.schema_version !== 2) throw new Error('validateV2 只接受 schema_version=2');
  requireString(record, 'record_id', '记录');

  requireUniqueIds(record.identity_merges, 'merge_id', '跨平台合并');
  const mergeIds = new Set();
  for (const m of record.identity_merges ?? []) {
    mergeIds.add(m.merge_id);
    const where = `合并 ${m.merge_id}`;
    if (!Array.isArray(m.account_refs) || m.account_refs.length < 2) {
      throw new Error(`${where} 至少要列出两个被合并账号`);
    }
    requireString(m, 'canonical_account', where);
    requireIso(m.merged_at, where);
    requireString(m, 'basis', where); // 合并依据：同主体凭证，禁止按设备指纹猜测
  }

  requireUniqueIds(record.content_versions, 'version_id', '内容版本');
  const versionIds = new Set();
  for (const c of record.content_versions ?? []) {
    versionIds.add(c.version_id);
    const where = `内容版本 ${c.version_id}`;
    requireEnum(c.kind, ['chapter', 'shot'], where);
    requireEnum(c.status, ['draft', 'published'], where);
    requireIso(c.created_at, where);
    if (c.status === 'published') requireIso(c.published_at, where);
  }
  for (const c of record.content_versions ?? []) {
    if (c.supersedes && !versionIds.has(c.supersedes)) {
      throw new Error(`内容版本 ${c.version_id} 引用了不存在的 supersedes ${c.supersedes}`);
    }
  }

  requireUniqueIds(record.private_drafts, 'draft_id', '私人草稿');
  for (const d of record.private_drafts ?? []) {
    const where = `私人草稿 ${d.draft_id}`;
    if (!Array.isArray(d.allowed_editors) || d.allowed_editors.length === 0) {
      throw new Error(`${where} 必须显式列出获准编辑`);
    }
  }

  requireUniqueIds(record.activities, 'activity_id', '互动活动');
  for (const a of record.activities ?? []) validateActivity(a, { mergeIds, versionIds });

  requireUniqueIds(record.reward_settlements, 'settlement_id', '奖励结算');
  const settledFingerprints = new Set();
  for (const s of record.reward_settlements ?? []) {
    const where = `奖励结算 ${s.settlement_id}`;
    requireString(s, 'opinion_fingerprint', where);
    requireEnum(s.status, SETTLEMENT_STATUS, where);
    if (!Array.isArray(s.source_refs) || s.source_refs.length < 1) {
      throw new Error(`${where} 必须列出该意见出现过的所有入口`);
    }
    if (s.status === 'paid') {
      // 同一意见指纹全局只能成功计酬一次，无论它在多少个入口重复出现。
      if (settledFingerprints.has(s.opinion_fingerprint)) {
        throw new Error(`${where} 与已支付结算使用了相同意见指纹，构成重复计酬`);
      }
      settledFingerprints.add(s.opinion_fingerprint);
      requireIso(s.paid_at, where);
    }
  }

  return deepFreeze(structuredClone(record));
}

function validateActivity(a, ctx) {
  const where = `互动 ${a.activity_id}`;
  requireString(a, 'title', where);
  requireEnum(a.rules_status, RULE_STATUS, where);
  requireIso(a.scheduled_start_at, where);
  requireIso(a.deadline_at, where);
  if (Date.parse(a.deadline_at) <= Date.parse(a.scheduled_start_at)) {
    throw new Error(`${where} 截止时间必须晚于开始时间`);
  }
  if (a.target_content_version_id && !ctx.versionIds.has(a.target_content_version_id)) {
    throw new Error(`${where} 指向了不存在的内容版本 ${a.target_content_version_id}`);
  }

  if (!a.rules_snapshot) throw new Error(`${where} 缺少 rules_snapshot`);
  validateRulesSnapshot(a.rules_snapshot, where, a);

  requireUniqueIds(a.votes, 'vote_id', `${where} 的投票`);
  for (const v of a.votes ?? []) {
    const vw = `投票 ${v.vote_id}`;
    requireString(v, 'voter_account', vw);
    requireString(v, 'option', vw);
    requireEnum(v.status, VOTE_STATUS, vw);
    requireIso(v.submitted_at, vw);
    if (typeof v.weight !== 'number' || v.weight <= 0) throw new Error(`${vw} 权重必须为正`);
    if (Date.parse(v.submitted_at) > Date.parse(a.deadline_at)) {
      throw new Error(`${vw} 超过截止时间，迟到数据必须进 late_arrivals 而非 votes`);
    }
    if (v.status === 'withdrawn') requireIso(v.withdrawn_at, vw);
    if (v.status === 'refunded') {
      requireIso(v.refunded_at, vw);
      requireString(v, 'refund_id', vw);
    }
    if (v.merge_id && !ctx.mergeIds.has(v.merge_id)) {
      throw new Error(`${vw} 引用了未知合并 ${v.merge_id}`);
    }
  }

  requireUniqueIds(a.comment_threads, 'thread_id', `${where} 的评论主题`);
  for (const t of a.comment_threads ?? []) {
    const tw = `评论主题 ${t.thread_id}`;
    requireString(t, 'topic', tw);
    if (t.content_version_id && !ctx.versionIds.has(t.content_version_id)) {
      throw new Error(`${tw} 指向了不存在的内容版本`);
    }
    requireUniqueIds(t.comments, 'comment_id', tw);
    for (const c of t.comments ?? []) {
      const cw = `评论 ${c.comment_id}`;
      requireString(c, 'author_account', cw);
      requireIso(c.posted_at, cw);
      requireEnum(c.status, COMMENT_STATUS, cw);
      if (c.status === 'excluded') requireString(c, 'exclusion_basis', cw);
      requireString(c, 'opinion_fingerprint', cw); // 供跨入口去重
    }
  }

  const threadIds = new Set((a.comment_threads ?? []).map((t) => t.thread_id));
  requireUniqueIds(a.creator_responses, 'response_id', `${where} 的创作者回应`);
  for (const r of a.creator_responses ?? []) {
    const rw = `创作者回应 ${r.response_id}`;
    requireString(r, 'author', rw);
    requireIso(r.responded_at, rw);
    requireString(r, 'body', rw);
    for (const tid of r.addressed_thread_ids ?? []) {
      if (!threadIds.has(tid)) throw new Error(`${rw} 引用了不存在的评论主题 ${tid}`);
    }
  }

  requireUniqueIds(a.anomaly_flags, 'flag_id', `${where} 的异常标记`);
  const flagIds = new Set((a.anomaly_flags ?? []).map((f) => f.flag_id));
  for (const f of a.anomaly_flags ?? []) {
    const fw = `异常标记 ${f.flag_id}`;
    requireEnum(f.kind, FLAG_KINDS, fw);
    requireString(f, 'evidence', fw);
    requireIso(f.flagged_at, fw);
    requireEnum(f.resolution, FLAG_RESOLUTION, fw);
    requireString(f, 'resolution_reason', fw);
    if (f.resolution === 'excluded' && (!Array.isArray(f.affected_refs) || f.affected_refs.length === 0)) {
      throw new Error(`${fw} 已排除，必须列出受影响的票/评论引用`);
    }
    if (f.merge_id && !ctx.mergeIds.has(f.merge_id)) throw new Error(`${fw} 引用了未知合并`);
  }

  requireUniqueIds(a.late_arrivals, 'late_id', `${where} 的迟到数据`);
  for (const l of a.late_arrivals ?? []) {
    const lw = `迟到数据 ${l.late_id}`;
    requireEnum(l.disposition, LATE_DISPOSITION, lw);
    requireIso(l.observed_at, lw);
    requireString(l, 'kind', lw);
    requireString(l, 'basis', lw); // 为什么接收（仅主题）或隔离
  }

  requireUniqueIds(a.tally_snapshots, 'snapshot_id', `${where} 的计票快照`);
  const snapshotIds = new Set((a.tally_snapshots ?? []).map((s) => s.snapshot_id));
  for (const s of a.tally_snapshots ?? []) {
    const sw = `计票快照 ${s.snapshot_id}`;
    requireIso(s.computed_at, sw);
    requireEnum(s.kind, ['raw', 'adjusted'], sw);
    if (s.supersedes_snapshot && !snapshotIds.has(s.supersedes_snapshot)) {
      throw new Error(`${sw} 引用了未知前序快照`);
    }
    for (const fid of s.excluded_flag_ids ?? []) {
      if (!flagIds.has(fid)) throw new Error(`${sw} 排除了未知异常标记 ${fid}`);
    }
  }

  requireUniqueIds(a.decisions, 'decision_id', `${where} 的创作决定`);
  for (const d of a.decisions ?? []) {
    const dw = `创作决定 ${d.decision_id}`;
    if (!ctx.versionIds.has(d.content_version_id)) throw new Error(`${dw} 指向不存在的内容版本`);
    if (!snapshotIds.has(d.based_on_snapshot_id)) throw new Error(`${dw} 必须基于一个已存在的计票快照`);
    requireEnum(d.outcome, DECISION_OUTCOMES, dw);
    requireString(d, 'rationale', dw);
    requireIso(d.decided_at, dw);
    requireString(d, 'decided_by', dw);
    if (d.outcome === 'partially_adopted' && (!Array.isArray(d.adopted_elements) || d.adopted_elements.length === 0)) {
      throw new Error(`${dw} 部分采用必须列出采用要素`);
    }
  }

  requireUniqueIds(a.pledges, 'pledge_id', `${where} 的正式承诺`);
  for (const p of a.pledges ?? []) {
    const pw = `承诺 ${p.pledge_id}`;
    requireEnum(p.status, PLEDGE_STATUS, pw);
    requireString(p, 'statement', pw);
    requireString(p, 'audience_scope', pw);
    if (!Array.isArray(p.history) || p.history.length === 0) throw new Error(`${pw} 缺少追加式状态历史`);
    let prev = null;
    for (const h of p.history) {
      requireEnum(h.status, PLEDGE_STATUS, `${pw} 的历史`);
      requireIso(h.at, `${pw} 的历史`);
      requireString(h, 'by', `${pw} 的历史`);
      if (prev && h.at < prev) throw new Error(`${pw} 历史时间顺序错误`);
      prev = h.at;
    }
    if (p.status !== p.history[p.history.length - 1].status) {
      throw new Error(`${pw} 当前状态必须与历史最后一条一致`);
    }
    if (p.status === 'fulfilled' && (!Array.isArray(p.verification) || p.verification.length === 0)) {
      throw new Error(`${pw} 已履行必须提供可核验材料`);
    }
  }
}

function validateRulesSnapshot(r, where, a) {
  const rw = `${where} 的规则`;
  requireIso(r.frozen_at, rw);
  // 截止时间随快照固定：开始后活动顶层时间与快照不一致即视为被篡改。
  if (r.deadline_at && r.deadline_at !== a.deadline_at) {
    throw new Error(`${rw} 的截止时间与活动截止时间不一致`);
  }
  if (!Array.isArray(r.eligible_audience) || r.eligible_audience.length === 0) {
    throw new Error(`${rw} 必须在开始前固定参与资格`);
  }
  if (typeof r.default_weight !== 'number' || r.default_weight <= 0) {
    throw new Error(`${rw} 必须给出正的默认权重`);
  }
  for (const [seg, w] of Object.entries(r.weight_overrides ?? {})) {
    if (typeof w !== 'number' || w < 0) throw new Error(`${rw} 对 ${seg} 的权重非法`);
  }
  if (!Array.isArray(r.editor_non_delegable) || r.editor_non_delegable.length === 0) {
    throw new Error(`${rw} 必须列出编辑不可让渡的边界`);
  }
  // 两条底线写死在合同里：观众无否决权；热度不是创作命令。
  if (r.can_audience_veto !== false || r.heat_is_command !== false) {
    throw new Error(`${rw} 违反不可让渡边界：观众不能获得否决权，热度不得自动构成创作命令`);
  }
  if (a.rules_status === 'frozen' || a.rules_status === 'closed') {
    if (Date.parse(r.frozen_at) > Date.parse(a.scheduled_start_at)) {
      throw new Error(`${where} 的规则必须在互动开始前冻结`);
    }
  }
}

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  Object.freeze(value);
  for (const key of Reflect.ownKeys(value)) deepFreeze(value[key]);
  return value;
}

/* ------------------------------------------------------------------ */
/* 规则冻结：互动开始前固定资格/权重/截止/边界                           */
/* ------------------------------------------------------------------ */

/**
 * 以草稿规则创建一条互动（status=draft）。草稿可改；
 * 必须在 scheduled_start_at 之前调用 {@link freezeRules} 才能收集反馈。
 */
export function createActivity({ activity_id, title, scheduled_start_at, deadline_at, rules }) {
  const start = requireIso(scheduled_start_at, '互动');
  const end = requireIso(deadline_at, '互动');
  if (end <= start) throw new Error('截止时间必须晚于开始时间');
  if (!Array.isArray(rules.eligible_audience) || rules.eligible_audience.length === 0) {
    throw new Error('必须在开始前固定参与资格');
  }
  if (!Array.isArray(rules.editor_non_delegable) || rules.editor_non_delegable.length === 0) {
    throw new Error('必须列出编辑不可让渡的边界');
  }
  return {
    activity_id,
    title,
    scheduled_start_at,
    deadline_at,
    rules_status: 'draft',
    rules_snapshot: null,
    target_content_version_id: rules.target_content_version_id ?? null,
    votes: [],
    comment_threads: [],
    creator_responses: [],
    anomaly_flags: [],
    late_arrivals: [],
    tally_snapshots: [],
    decisions: [],
    pledges: [],
    _draft_rules: {
      can_audience_veto: false,
      heat_is_command: false,
      eligible_audience: rules.eligible_audience,
      default_weight: rules.default_weight ?? 1,
      weight_overrides: rules.weight_overrides ?? {},
      editor_non_delegable: rules.editor_non_delegable,
    },
  };
}

/**
 * 在互动开始前冻结规则：把资格/权重/边界拍成不可变快照。
 * 开始后再改规则一律拒绝；想改只能开一场新活动。
 */
export function freezeRules(activity, frozenAt = new Date().toISOString()) {
  if (activity.rules_status !== 'draft' || !activity._draft_rules) {
    throw new Error(`互动 ${activity.activity_id} 规则已冻结，不能修改`);
  }
  if (Date.parse(frozenAt) > Date.parse(activity.scheduled_start_at)) {
    throw new Error('规则必须在互动开始前冻结');
  }
  const next = structuredClone(activity);
  next.rules_snapshot = {
    frozen_at: frozenAt,
    scheduled_start_at: next.scheduled_start_at,
    deadline_at: next.deadline_at,
    ...next._draft_rules,
  };
  delete next._draft_rules;
  next.rules_status = 'frozen';
  return next;
}

/** 关闭活动：关闭后不再接受票/评论，已有快照与决定保持不变。 */
export function closeActivity(activity, closedAt = new Date().toISOString()) {
  if (activity.rules_status !== 'frozen') throw new Error('只有已冻结活动可以关闭');
  if (Date.parse(closedAt) < Date.parse(activity.scheduled_start_at)) throw new Error('关闭时间不能早于开始时间');
  return { ...structuredClone(activity), rules_status: 'closed' };
}
