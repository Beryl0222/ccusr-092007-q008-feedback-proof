import { validateV2, DECISION_OUTCOMES, PLEDGE_STATUS } from './contracts.js';
import { makeFingerprint } from './feedback.js';

/**
 * 创作侧：内容版本不可变、创作决定溯源、订阅者承诺核验、
 * 私人草稿访问控制、贡献奖励跨入口去重。
 */

const clone = (x) => structuredClone(x);

function mutate(record, fn) {
  const next = clone(record);
  fn(next);
  return validateV2(next);
}

function mutateActivity(record, activityId, fn) {
  return mutate(record, (r) => {
    const a = r.activities.find((x) => x.activity_id === activityId);
    if (!a) throw new Error(`未知互动 ${activityId}`);
    fn(a);
  });
}

/* ------------------------------------------------------------------ */
/* 内容版本：已发布的章节/镜头永不被重算修改                            */
/* ------------------------------------------------------------------ */

/**
 * 登记一个内容版本。新版本只能 supersedes 旧版本（追加），
 * 已 published 的版本状态不可再改——本模块刻意不提供任何“改发布版本”的入口。
 */
export function addContentVersion(record, { version_id, kind, created_at, status = 'draft', published_at = null, supersedes = null }) {
  return mutate(record, (r) => {
    if (r.content_versions.some((c) => c.version_id === version_id)) throw new Error(`内容版本 ${version_id} 已存在`);
    r.content_versions.push({ version_id, kind, created_at, status, published_at, supersedes });
  });
}

/** 草稿 → 发布。发布时间一旦记录不可撤销；重算流程也无权调用它去改旧版本。 */
export function publishContentVersion(record, { version_id, published_at }) {
  return mutate(record, (r) => {
    const c = r.content_versions.find((x) => x.version_id === version_id);
    if (!c) throw new Error(`未知内容版本 ${version_id}`);
    if (c.status === 'published') throw new Error('已发布版本不可重复发布或修改');
    c.status = 'published';
    c.published_at = published_at;
  });
}

/* ------------------------------------------------------------------ */
/* 创作决定：采用/部分采用/拒绝 + 理由，且必须能追溯到计票快照           */
/* ------------------------------------------------------------------ */

/**
 * 记录创作决定。它是“热度 → 内容”之间唯一合法的桥，并且必须由人（decided_by）
 * 显式作出：系统不会因为某选项领先就自动改动内容。
 * based_on_snapshot_id 把内容变化钉在某个具体计票快照（raw 或 adjusted 都行，需说明）。
 */
export function recordDecision(record, { activity_id, decision_id, content_version_id, based_on_snapshot_id, outcome, rationale, decided_by, decided_at, adopted_elements = undefined }) {
  if (!DECISION_OUTCOMES.includes(outcome)) throw new Error(`决定结果非法：${outcome}`);
  if (!rationale || !rationale.trim()) throw new Error('创作决定必须写明理由');
  return mutateActivity(record, activity_id, (a) => {
    if (a.decisions.some((d) => d.decision_id === decision_id)) throw new Error(`决定 ${decision_id} 已存在`);
    const snapshot = a.tally_snapshots.find((s) => s.snapshot_id === based_on_snapshot_id);
    if (!snapshot) throw new Error('决定必须基于一个已存在的计票快照');
    if (a.decisions.some((d) => d.content_version_id === content_version_id)) {
      throw new Error(`内容版本 ${content_version_id} 已有决定；请对新版本再记录，不得改写旧决定`);
    }
    const d = {
      decision_id,
      content_version_id,
      based_on_snapshot_id,
      based_on_snapshot_kind: snapshot.kind,
      outcome,
      rationale,
      decided_by,
      decided_at,
    };
    if (outcome === 'partially_adopted') d.adopted_elements = adopted_elements;
    a.decisions.push(d);
  });
}

/** 追溯：某个内容版本的变化实际依据了哪场互动的哪一版计票结果。 */
export function traceContentChange(record, version_id) {
  const version = record.content_versions.find((c) => c.version_id === version_id);
  if (!version) throw new Error(`未知内容版本 ${version_id}`);
  const hits = [];
  for (const a of record.activities) {
    for (const d of a.decisions) {
      if (d.content_version_id !== version_id) continue;
      const snapshot = a.tally_snapshots.find((s) => s.snapshot_id === d.based_on_snapshot_id);
      hits.push({
        activity_id: a.activity_id,
        decision_id: d.decision_id,
        outcome: d.outcome,
        rationale: d.rationale,
        decided_by: d.decided_by,
        decided_at: d.decided_at,
        based_on: {
          snapshot_id: snapshot.snapshot_id,
          kind: snapshot.kind, // 依据的是原始结果还是排除异常后的结果
          computed_at: snapshot.computed_at,
          ranking: snapshot.ranking,
          excluded_flag_ids: snapshot.excluded_flag_ids,
        },
      });
    }
  }
  return { version, basis: hits };
}

/* ------------------------------------------------------------------ */
/* 正式承诺：对订阅者作出的承诺提供可核验状态；讨论不是承诺              */
/* ------------------------------------------------------------------ */

/**
 * 登记承诺。初始 status=proposed（草拟）或 made（已对外）。
 * 创作者在评论区/直播里的讨论若不进 pledges，就不构成承诺——
 * 这避免网文作者把“讨论”误读成“续篇承诺”。
 */
export function createPledge(record, { activity_id, pledge_id, statement, audience_scope, status = 'proposed', at, by, verification = null }) {
  if (!PLEDGE_STATUS.includes(status)) throw new Error(`承诺状态非法：${status}`);
  if (status === 'fulfilled' && (!Array.isArray(verification) || verification.length === 0)) {
    throw new Error('直接登记为已履行必须附核验材料');
  }
  return mutateActivity(record, activity_id, (a) => {
    if (a.pledges.some((p) => p.pledge_id === pledge_id)) throw new Error(`承诺 ${pledge_id} 已存在`);
    a.pledges.push({
      pledge_id,
      statement,
      audience_scope,
      status,
      verification: status === 'fulfilled' ? verification : null,
      history: [{ status, at, by, note: 'created' }],
    });
  });
}

/** 追加承诺状态（made → in_progress → fulfilled / withdrawn）。只能追加历史，不能回改旧条目。 */
export function transitionPledge(record, { activity_id, pledge_id, status, at, by, note = '', verification = null }) {
  if (!PLEDGE_STATUS.includes(status)) throw new Error(`承诺状态非法：${status}`);
  return mutateActivity(record, activity_id, (a) => {
    const p = a.pledges.find((x) => x.pledge_id === pledge_id);
    if (!p) throw new Error(`未知承诺 ${pledge_id}`);
    if (status === 'fulfilled' && (!Array.isArray(verification) || verification.length === 0)) {
      throw new Error('履行承诺必须附可核验材料（如章节链接、发布凭证）');
    }
    if (at <= p.history[p.history.length - 1].at) throw new Error('承诺状态历史只能按时间追加');
    p.status = status;
    p.history.push({ status, at, by, note });
    if (status === 'fulfilled') p.verification = verification;
    if (status === 'withdrawn') p.verification = null;
  });
}

/** 订阅者可核验视图：当前状态 + 完整历史 + 履行凭证，不暴露任何私人草稿。 */
export function publicPledgeStatus(record, activity_id, pledge_id) {
  const a = record.activities.find((x) => x.activity_id === activity_id);
  if (!a) throw new Error(`未知互动 ${activity_id}`);
  const p = a.pledges.find((x) => x.pledge_id === pledge_id);
  if (!p) throw new Error(`未知承诺 ${pledge_id}`);
  return {
    pledge_id: p.pledge_id,
    statement: p.statement,
    audience_scope: p.audience_scope,
    status: p.status,
    verification: p.verification,
    history: p.history.map(({ status, at, note }) => ({ status, at, note })),
  };
}

/* ------------------------------------------------------------------ */
/* 私人草稿：只有获准编辑可见                                           */
/* ------------------------------------------------------------------ */

export function addPrivateDraft(record, { draft_id, owner, title, body, created_at, allowed_editors }) {
  if (!Array.isArray(allowed_editors) || allowed_editors.length === 0) {
    throw new Error('私人草稿必须显式列出获准编辑');
  }
  return mutate(record, (r) => {
    if (r.private_drafts.some((d) => d.draft_id === draft_id)) throw new Error(`草稿 ${draft_id} 已存在`);
    r.private_drafts.push({ draft_id, owner, title, body, created_at, allowed_editors: [...new Set([owner, ...allowed_editors])] });
  });
}

/** 读取私人草稿：非 allowed_editors 一律拒绝，哪怕是其他创作者或订阅者。 */
export function readPrivateDraft(record, draft_id, editor) {
  const d = record.private_drafts.find((x) => x.draft_id === draft_id);
  if (!d) throw new Error(`未知草稿 ${draft_id}`);
  if (!d.allowed_editors.includes(editor)) {
    throw new Error(`编辑 ${editor} 无权访问私人草稿 ${draft_id}`);
  }
  return d;
}

/* ------------------------------------------------------------------ */
/* 贡献奖励：同一意见跨多入口只计酬一次                                  */
/* ------------------------------------------------------------------ */

/**
 * 结算一条意见。source_refs 必须列出该意见出现的全部入口
 * （comment:<id>、vote:<id>、late:<id>、外部平台链接等）。
 * 同一 opinion_fingerprint 全记录只能有一笔 paid：重复入口在结算时合并，不重复发钱。
 */
export function settleReward(record, { settlement_id, opinion_text = null, opinion_fingerprint = null, source_refs, payee, amount, currency = 'CNY', status = 'pending', paid_at = null }) {
  if (!Array.isArray(source_refs) || source_refs.length === 0) throw new Error('结算必须至少给出一个来源入口');
  const fp = opinion_fingerprint ?? makeFingerprint(opinion_text ?? source_refs.join('|'));
  return mutate(record, (r) => {
    if (r.reward_settlements.some((s) => s.settlement_id === settlement_id)) throw new Error(`结算 ${settlement_id} 已存在`);
    const entry = {
      settlement_id,
      opinion_fingerprint: fp,
      source_refs: [...new Set(source_refs)], // 去重同一入口的重复登记
      payee,
      amount,
      currency,
      status,
    };
    if (status === 'paid') entry.paid_at = paid_at ?? new Date().toISOString();
    r.reward_settlements.push(entry);
  });
}

/**
 * 结算前预检：返回每条待结意见是否与已 paid 指纹冲突、以及合并了哪些入口。
 * 编辑据此确认“同一意见多入口只计一次”，而不是逐入口发奖。
 */
export function previewSettlements(record, candidates) {
  const paid = new Map();
  for (const s of record.reward_settlements) if (s.status === 'paid') paid.set(s.opinion_fingerprint, s);
  // 同批内也要去重。
  const batch = new Map();
  return candidates.map((c) => {
    const fp = c.opinion_fingerprint ?? makeFingerprint(c.opinion_text ?? c.source_refs.join('|'));
    const refs = [...new Set(c.source_refs)];
    const duplicate_of_paid = paid.has(fp) ? paid.get(fp).settlement_id : null;
    const merged_within_batch = batch.has(fp) ? batch.get(fp) : null;
    if (!batch.has(fp)) batch.set(fp, c.settlement_id);
    return { settlement_id: c.settlement_id, opinion_fingerprint: fp, merged_source_refs: refs, duplicate_of_paid, merged_within_batch, payable: !duplicate_of_paid && !merged_within_batch };
  });
}
