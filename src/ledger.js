/**
 * 调整台账模块。
 * 跨平台账号合并、撤票、退款用户、异常协同行为、迟到数据，
 * 都必须以一条 adjustments_ledger 记录留下处理依据（规则条款 + 证据 + 决定人 + 决定时间）。
 * 台账是追加式的：只能新增调整，不得删除或改写已有调整。
 */

export const ADJUSTMENT_KINDS = Object.freeze({
  IDENTITY_DEDUP: 'identity_dedup',
  REFUND_EXCLUSION: 'refund_exclusion',
  INELIGIBLE_WEIGHT: 'ineligible_weight',
  WITHDRAWAL: 'withdrawal',
  COORDINATED_CLUSTER: 'coordinated_cluster',
  LATE_DATA: 'late_data',
});

/** 会使票退出有效计票的调整效果；mark_late 单独成类，保留在迟到通道。 */
const EXCLUSION_EFFECTS = new Set(['dedup_vote', 'exclude_vote', 'exclude_cluster']);

function byId(items, key) {
  return new Map((items ?? []).map((item) => [item[key], item]));
}

/** 校验台账完整性：引用必须存在、依据字段必须齐全、一票不得被重复排除。 */
export function validateAdjustments(record, interactionId) {
  const interactions = byId(record.interactions, 'interaction_id');
  const interaction = interactions.get(interactionId);
  if (!interaction) throw new Error(`互动不存在: ${interactionId}`);

  const votes = byId(
    (record.votes ?? []).filter((v) => v.interaction_id === interactionId),
    'vote_id',
  );
  const adjustments = (record.adjustments_ledger ?? []).filter(
    (a) => a.interaction_id === interactionId,
  );

  const effectiveExcluded = new Map(); // vote_id -> adjustment_id
  const seenAdjustmentIds = new Set();

  for (const adj of adjustments) {
    if (seenAdjustmentIds.has(adj.adjustment_id)) {
      throw new Error(`调整记录重复: ${adj.adjustment_id}`);
    }
    seenAdjustmentIds.add(adj.adjustment_id);

    for (const required of ['kind', 'basis', 'evidence_ref', 'rule_clause', 'decided_by', 'decided_at']) {
      if (!adj[required]) throw new Error(`调整 ${adj.adjustment_id} 缺少处理依据字段: ${required}`);
    }
    if (!Object.values(ADJUSTMENT_KINDS).includes(adj.kind)) {
      throw new Error(`调整 ${adj.adjustment_id} 类型未知: ${adj.kind}`);
    }
    if (Date.parse(adj.decided_at) < Date.parse(interaction.closes_at)) {
      throw new Error(`调整 ${adj.adjustment_id} 决定时间早于截止时间，依据不能先于事件产生`);
    }

    for (const voteId of adj.target_vote_ids ?? []) {
      if (!votes.has(voteId)) throw new Error(`调整 ${adj.adjustment_id} 引用了不存在的票: ${voteId}`);
      if (adj.kind === ADJUSTMENT_KINDS.IDENTITY_DEDUP && voteId === adj.kept_vote_id) {
        throw new Error(`调整 ${adj.adjustment_id} 去重保留票不能同时是被剔除票`);
      }
      if (EXCLUSION_EFFECTS.has(adj.effect)) {
        if (effectiveExcluded.has(voteId)) {
          throw new Error(
            `票 ${voteId} 被调整 ${effectiveExcluded.get(voteId)} 与 ${adj.adjustment_id} 重复排除`,
          );
        }
        effectiveExcluded.set(voteId, adj.adjustment_id);
      }
    }

    if (adj.kind === ADJUSTMENT_KINDS.IDENTITY_DEDUP) {
      if (!adj.kept_vote_id || !votes.has(adj.kept_vote_id)) {
        throw new Error(`去重调整 ${adj.adjustment_id} 缺少有效的保留票 kept_vote_id`);
      }
    }
    if (adj.kind === ADJUSTMENT_KINDS.COORDINATED_CLUSTER && !adj.target_cluster_id) {
      throw new Error(`协同异常调整 ${adj.adjustment_id} 缺少 target_cluster_id`);
    }
  }

  return { valid: true, adjustmentCount: adjustments.length, excludedVoteIds: [...effectiveExcluded.keys()] };
}

/**
 * 给出每一票的处置归类，供并排核对。
 * raw：收到的全部票；adjusted：仅有效票；迟到票单列，绝不进入任何正式计票。
 */
export function classifyVotes(record, interactionId) {
  validateAdjustments(record, interactionId);
  const interaction = byId(record.interactions, 'interaction_id').get(interactionId);
  const votes = (record.votes ?? []).filter((v) => v.interaction_id === interactionId);
  const adjustments = (record.adjustments_ledger ?? []).filter(
    (a) => a.interaction_id === interactionId,
  );

  const disposition = new Map();
  const late = new Set();
  for (const adj of adjustments) {
    for (const voteId of adj.target_vote_ids ?? []) {
      if (adj.effect === 'mark_late') {
        late.add(voteId);
        disposition.set(voteId, { status: 'late', adjustment_id: adj.adjustment_id });
      } else {
        disposition.set(voteId, { status: 'excluded', adjustment_id: adj.adjustment_id, kind: adj.kind });
      }
    }
  }

  const result = {
    raw: [],
    excluded: [],
    late: [],
    counted: [],
    cutoff: interaction.closes_at,
  };

  for (const vote of votes) {
    result.raw.push(vote.vote_id);
    const d = disposition.get(vote.vote_id);
    const afterCutoff = Date.parse(vote.cast_at) > Date.parse(interaction.closes_at);
    if (d?.status === 'late' || afterCutoff) {
      result.late.push(vote.vote_id);
      continue;
    }
    if (d?.status === 'excluded') {
      result.excluded.push({ vote_id: vote.vote_id, adjustment_id: d.adjustment_id, kind: d.kind });
      continue;
    }
    result.counted.push(vote.vote_id);
  }

  return result;
}

/** 权重查询：身份层级必须在锁定规则的权重表中有定义。 */
export function weightOf(interaction, identity) {
  const entry = interaction.eligibility.weight_classes.find((w) => w.class === identity?.tier);
  if (!entry) throw new Error(`身份层级 ${identity?.tier} 不在锁定权重表中`);
  return entry.weight;
}
