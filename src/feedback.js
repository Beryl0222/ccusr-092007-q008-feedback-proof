import { validateV2, VOTE_STATUS, FLAG_RESOLUTION, LATE_DISPOSITION } from './contracts.js';

/**
 * 反馈采集与计票。所有函数都是“取记录、返回新记录”的纯操作：
 * 不改旧快照、不改已发布内容版本；落库前统一过 validateV2 校验。
 */

const clone = (x) => structuredClone(x);

function mutateActivity(record, activityId, fn) {
  const next = clone(record);
  const idx = next.activities.findIndex((a) => a.activity_id === activityId);
  if (idx === -1) throw new Error(`未知互动 ${activityId}`);
  fn(next.activities[idx]);
  return validateV2(next);
}

function requireFrozen(a) {
  if (a.rules_status !== 'frozen') {
    throw new Error(`互动 ${a.activity_id} 当前状态 ${a.rules_status}，只在规则冻结后、关闭前收集反馈`);
  }
}

/** 用冻结时的规则快照解析票重：资格与权重在开始后不可改，票上不能自带权重。 */
function resolveWeight(activity, segment) {
  const r = activity.rules_snapshot;
  if (!r.eligible_audience.includes(segment)) {
    throw new Error(`资格 ${segment} 不在开始前冻结的参与资格内：${r.eligible_audience.join(' / ')}`);
  }
  return r.weight_overrides[segment] ?? r.default_weight;
}

/* ------------------------------------------------------------------ */
/* 跨平台账号合并                                                       */
/* ------------------------------------------------------------------ */

/**
 * 登记跨平台合并。basis 必须是同主体凭证（如已验证绑定），
 * 不允许按设备/IP 猜测；被合并账号的票按 merge_id 留痕，计票只认 canonical_account。
 */
export function addIdentityMerge(record, { merge_id, account_refs, canonical_account, merged_at, basis }) {
  const next = clone(record);
  if (next.identity_merges.some((m) => m.merge_id === merge_id)) throw new Error(`合并 ${merge_id} 已存在`);
  next.identity_merges.push({ merge_id, account_refs, canonical_account, merged_at, basis });
  return validateV2(next);
}

/* ------------------------------------------------------------------ */
/* 投票：资格校验、撤票、退款                                           */
/* ------------------------------------------------------------------ */

export function addVote(record, { activity_id, vote_id, voter_account, segment, option, submitted_at, merge_id = null }) {
  return mutateActivity(record, activity_id, (a) => {
    requireFrozen(a);
    if (Date.parse(submitted_at) > Date.parse(a.deadline_at)) {
      throw new Error(`投票 ${vote_id} 晚于截止时间，应登记为迟到数据而不是直接入票`);
    }
    if (a.votes.some((v) => v.vote_id === vote_id)) throw new Error(`投票 ${vote_id} 重复`);
    const weight = resolveWeight(a, segment);
    a.votes.push({
      vote_id,
      voter_account,
      segment,
      option,
      submitted_at,
      weight, // 来自冻结快照，记录在案
      status: 'counted',
      merge_id,
    });
  });
}

function changeVoteStatus(record, activityId, voteId, patch) {
  return mutateActivity(record, activityId, (a) => {
    const v = a.votes.find((x) => x.vote_id === voteId);
    if (!v) throw new Error(`未知投票 ${voteId}`);
    if (v.status !== 'counted') throw new Error(`投票 ${voteId} 已处于 ${v.status}，状态只能单向流转`);
    Object.assign(v, patch);
  });
}

/** 撤票：保留原票与撤票时间，计票时排除。 */
export function withdrawVote(record, { activity_id, vote_id, withdrawn_at }) {
  return changeVoteStatus(record, activity_id, vote_id, { status: 'withdrawn', withdrawn_at });
}

/** 退款用户：除撤票外还要留下退款单号，便于和支付侧对账。 */
export function refundVote(record, { activity_id, vote_id, refund_id, refunded_at }) {
  if (!refund_id) throw new Error('退款必须提供 refund_id');
  return changeVoteStatus(record, activity_id, vote_id, { status: 'refunded', refund_id, refunded_at });
}

/* ------------------------------------------------------------------ */
/* 评论主题与意见指纹（跨入口去重的依据）                                */
/* ------------------------------------------------------------------ */

/**
 * 生成意见指纹：小写化、去标点与空白差异。同一意见在直播弹幕、
 * 评论区、私信等多个入口出现时指纹一致，奖励结算只认一次。
 */
export function makeFingerprint(text) {
  const normalized = String(text).normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');
  let h = 5381;
  for (const ch of normalized) h = ((h << 5) + h + ch.codePointAt(0)) >>> 0;
  return `fp_${h.toString(16).padStart(8, '0')}`;
}

export function addCommentThread(record, { activity_id, thread_id, topic, content_version_id = null }) {
  return mutateActivity(record, activity_id, (a) => {
    requireFrozen(a);
    if (a.comment_threads.some((t) => t.thread_id === thread_id)) throw new Error(`主题 ${thread_id} 已存在`);
    a.comment_threads.push({ thread_id, topic, content_version_id, comments: [] });
  });
}

export function addComment(record, { activity_id, thread_id, comment_id, author_account, text, posted_at, status = 'counted', exclusion_basis = null }) {
  return mutateActivity(record, activity_id, (a) => {
    requireFrozen(a);
    const t = a.comment_threads.find((x) => x.thread_id === thread_id);
    if (!t) throw new Error(`未知评论主题 ${thread_id}`);
    if (t.comments.some((c) => c.comment_id === comment_id)) throw new Error(`评论 ${comment_id} 重复`);
    if (status === 'excluded' && !exclusion_basis) throw new Error('排除评论必须给出 exclusion_basis');
    t.comments.push({
      comment_id,
      author_account,
      text,
      posted_at,
      status,
      exclusion_basis,
      opinion_fingerprint: makeFingerprint(text),
    });
  });
}

export function addCreatorResponse(record, { activity_id, response_id, author, body, responded_at, addressed_thread_ids = [], addressed_vote_option = null }) {
  return mutateActivity(record, activity_id, (a) => {
    requireFrozen(a);
    a.creator_responses.push({ response_id, author, body, responded_at, addressed_thread_ids, addressed_vote_option });
  });
}

/* ------------------------------------------------------------------ */
/* 异常协同行为与迟到数据                                                */
/* ------------------------------------------------------------------ */

/**
 * 登记异常（协同刷屏、搬运投票、多账号等）。resolution 决定处理：
 * excluded 必须列出受影响引用（vote:…/comment:…），调整后计票据此排除，
 * 原始计票仍保留它们，两边并排可查；quarantined 待复核，先不排除。
 */
export function flagAnomaly(record, { activity_id, flag_id, kind, evidence, flagged_at, resolution, resolution_reason, affected_refs = [], merge_id = null }) {
  if (resolution === 'excluded' && affected_refs.length === 0) {
    throw new Error('判定排除时必须给出 affected_refs');
  }
  if (!FLAG_RESOLUTION.includes(resolution)) throw new Error(`异常处置非法：${resolution}`);
  return mutateActivity(record, activity_id, (a) => {
    if (a.anomaly_flags.some((f) => f.flag_id === flag_id)) throw new Error(`异常标记 ${flag_id} 已存在`);
    a.anomaly_flags.push({ flag_id, kind, evidence, flagged_at, resolution, resolution_reason, affected_refs, merge_id });
  });
}

/**
 * 迟到数据：截止后到达，永远不进 votes。
 * accepted_for_themes_only 只能影响评论主题归纳，不得改票数；
 * quarantined 完全隔离。basis 必填，说明处理依据。
 */
export function addLateArrival(record, { activity_id, late_id, kind, payload, observed_at, disposition, basis }) {
  if (!LATE_DISPOSITION.includes(disposition)) throw new Error(`迟到处置非法：${disposition}`);
  return mutateActivity(record, activity_id, (a) => {
    if (a.late_arrivals.some((l) => l.late_id === late_id)) throw new Error(`迟到记录 ${late_id} 已存在`);
    a.late_arrivals.push({ late_id, kind, payload, observed_at, disposition, basis });
  });
}

/* ------------------------------------------------------------------ */
/* 计票与重算：原始 / 调整并排，快照只追加                               */
/* ------------------------------------------------------------------ */

function emptyTally() {
  return { options: {}, total_weighted: 0, ballot_count: 0 };
}

function tallyFromVotes(votes, excludedVoteIds) {
  const tally = emptyTally();
  for (const v of votes) {
    if (v.status !== 'counted') continue; // 撤票、退款不参与任何计票
    if (excludedVoteIds.has(v.vote_id)) continue;
    tally.options[v.option] ??= { weighted: 0, ballots: 0 };
    tally.options[v.option].weighted += v.weight;
    tally.options[v.option].ballots += 1;
    tally.total_weighted += v.weight;
    tally.ballot_count += 1;
  }
  return tally;
}

function ranking(tally) {
  return Object.entries(tally.options)
    .sort((a, b) => b[1].weighted - a[1].weighted || a[0].localeCompare(b[0]))
    .map(([option]) => option);
}

function excludedVoteIdsFor(activity, flagIds) {
  const ids = new Set();
  for (const f of activity.anomaly_flags) {
    if (f.resolution !== 'excluded') continue;
    if (flagIds && !flagIds.includes(f.flag_id)) continue;
    for (const ref of f.affected_refs) {
      if (ref.startsWith('vote:')) ids.add(ref.slice('vote:'.length));
    }
  }
  return ids;
}

/**
 * 生成计票快照。
 * - kind=raw：除撤票/退款外不排除任何票（含疑似异常），作为“原始结果”；
 * - kind=adjusted：按 excluded_flag_ids 排除异常，作为“排除异常后结果”。
 * 快照只追加：重算传 supersedes_snapshot，旧快照原样保留。
 */
export function computeTallySnapshot(record, { activity_id, snapshot_id, computed_at, kind, excluded_flag_ids = [], supersedes_snapshot = null }) {
  if (!['raw', 'adjusted'].includes(kind)) throw new Error('快照 kind 只能是 raw/adjusted');
  return mutateActivity(record, activity_id, (a) => {
    if (a.tally_snapshots.some((s) => s.snapshot_id === snapshot_id)) throw new Error(`快照 ${snapshot_id} 已存在`);
    const excluded = kind === 'adjusted' ? excludedVoteIdsFor(a, excluded_flag_ids) : new Set();
    if (kind === 'adjusted') {
      for (const id of excluded_flag_ids) {
        const f = a.anomaly_flags.find((x) => x.flag_id === id);
        if (!f || f.resolution !== 'excluded') throw new Error(`调整快照只能引用已判定排除的标记：${id}`);
      }
    }
    const tally = tallyFromVotes(a.votes, excluded);
    a.tally_snapshots.push({
      snapshot_id,
      computed_at,
      kind,
      supersedes_snapshot,
      excluded_flag_ids: kind === 'adjusted' ? [...excluded_flag_ids] : [],
      excluded_vote_ids: [...excluded].sort(),
      tally,
      ranking: ranking(tally),
    });
  });
}

/** 并排对比两份快照：每选项加权票差、排名变化、被排除的票。 */
export function diffSnapshots(activity, leftId, rightId) {
  const l = activity.tally_snapshots.find((s) => s.snapshot_id === leftId);
  const r = activity.tally_snapshots.find((s) => s.snapshot_id === rightId);
  if (!l || !r) throw new Error('对比引用了不存在的快照');
  const options = new Set([...Object.keys(l.tally.options), ...Object.keys(r.tally.options)]);
  const per_option = {};
  for (const opt of options) {
    const lw = l.tally.options[opt]?.weighted ?? 0;
    const rw = r.tally.options[opt]?.weighted ?? 0;
    per_option[opt] = {
      [`${l.snapshot_id}_weighted`]: lw,
      [`${r.snapshot_id}_weighted`]: rw,
      delta: rw - lw,
    };
  }
  const lr = l.ranking;
  const rr = r.ranking;
  const rank_changes = [];
  for (const opt of options) {
    const li = lr.indexOf(opt);
    const ri = rr.indexOf(opt);
    if (li !== ri) rank_changes.push({ option: opt, from: li === -1 ? null : li + 1, to: ri === -1 ? null : ri + 1 });
  }
  return {
    left: { snapshot_id: l.snapshot_id, kind: l.kind, total_weighted: l.tally.total_weighted },
    right: { snapshot_id: r.snapshot_id, kind: r.kind, total_weighted: r.tally.total_weighted },
    per_option,
    rank_changes,
    winner_changed: lr[0] !== rr[0],
    excluded_between: r.excluded_vote_ids.filter((id) => !l.excluded_vote_ids.includes(id)),
  };
}

/** 评论主题归纳：默认只统计 counted 评论；可纳入“仅主题可用”的迟到数据，但永不改票数。 */
export function aggregateCommentThemes(activity, { includeLateAccepted = false } = {}) {
  const byFingerprint = new Map();
  const ingest = (c, source) => {
    if (c.status === 'excluded') return;
    const row = byFingerprint.get(c.opinion_fingerprint) ?? { fingerprint: c.opinion_fingerprint, count: 0, example: c.text, sources: [] };
    row.count += 1;
    if (!row.sources.includes(source)) row.sources.push(source);
    byFingerprint.set(c.opinion_fingerprint, row);
  };
  for (const t of activity.comment_threads) for (const c of t.comments) ingest(c, 'on_time');
  if (includeLateAccepted) {
    for (const l of activity.late_arrivals) {
      if (l.disposition !== 'accepted_for_themes_only' || l.kind !== 'comment') continue;
      ingest({ ...l.payload, opinion_fingerprint: makeFingerprint(l.payload.text), status: 'counted' }, 'late_themes_only');
    }
  }
  return [...byFingerprint.values()].sort((a, b) => b.count - a.count);
}

export { VOTE_STATUS };
