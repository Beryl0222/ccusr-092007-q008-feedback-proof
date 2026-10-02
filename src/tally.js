import { createHash } from 'node:crypto';
import { classifyVotes, validateAdjustments } from './ledger.js';
import { computeRulesHash, verifyRulesHash } from './rules.js';

/**
 * 计票模块。
 * - raw：收到的全部投票事件（审计流视角，迟到、撤回、重复、刷票均保留可见）
 * - adjusted：依据锁定规则与调整台账剔除后的有效票（迟到票单列，绝不计入）
 * 计票运行追加式保存；重算只产生新运行，绝不改写旧运行，也绝不触碰已发布内容。
 */

function byId(items, key) {
  return new Map((items ?? []).map((item) => [item[key], item]));
}

function tallyBallots(votes) {
  const ballots = {};
  for (const v of votes) {
    ballots[v.option_id] = (ballots[v.option_id] ?? 0) + 1;
  }
  return ballots;
}

/**
 * 原始口径：在截止时间及以前投出的全部投票事件，不做去重、资格或异常剔除
 * （撤票、退款票、游客票、刷票票在此口径仍可见）。
 * 截止后投出的票不进任何计票口径，只进迟到通道，但在原始事件流中保留。
 */
export function rawTally(record, interactionId) {
  const interaction = byId(record.interactions, 'interaction_id').get(interactionId);
  const cutoff = Date.parse(interaction.closes_at);
  const votes = (record.votes ?? []).filter(
    (v) => v.interaction_id === interactionId && Date.parse(v.cast_at) <= cutoff,
  );
  return tallyBallots(votes);
}

/**
 * 调整口径：只统计有效票。
 * 有效票必须：未被台账排除、未迟到；身份权重为 0 的票贡献 0。
 */
export function adjustedTally(record, interactionId) {
  validateAdjustments(record, interactionId);
  const interaction = byId(record.interactions, 'interaction_id').get(interactionId);
  const identities = byId(record.identities, 'identity_id');
  const classification = classifyVotes(record, interactionId);
  const countedSet = new Set(classification.counted);
  const votes = (record.votes ?? []).filter((v) => v.interaction_id === interactionId && countedSet.has(v.vote_id));

  const ballots = {};
  for (const option of interaction.options) ballots[option.option_id] = 0;
  for (const v of votes) {
    const identity = identities.get(v.identity_id);
    const weightClass = interaction.eligibility.weight_classes.find((w) => w.class === identity?.tier);
    const weight = weightClass?.weight ?? 0;
    ballots[v.option_id] = (ballots[v.option_id] ?? 0) + weight;
  }
  return ballots;
}

/** 构造一次新的计票运行（冻结返回，由调用方追加进记录）。 */
export function buildRun(record, interactionId, fields) {
  const interaction = byId(record.interactions, 'interaction_id').get(interactionId);
  if (!interaction) throw new Error(`互动不存在: ${interactionId}`);

  for (const required of ['run_id', 'computed_at', 'kind', 'status']) {
    if (!fields[required]) throw new Error(`计票运行缺少字段: ${required}`);
  }
  if (fields.supersedes) {
    const prior = (record.tally_runs ?? []).find((r) => r.run_id === fields.supersedes);
    if (!prior) throw new Error(`被取代的计票运行不存在: ${fields.supersedes}`);
  }

  const classification = classifyVotes(record, interactionId);
  const appliedIds = fields.adjustments_applied ?? [];
  const ledgerIds = new Set(
    (record.adjustments_ledger ?? [])
      .filter((a) => a.interaction_id === interactionId)
      .map((a) => a.adjustment_id),
  );
  for (const id of appliedIds) {
    if (!ledgerIds.has(id)) throw new Error(`计票运行引用了台账中不存在的调整: ${id}`);
  }

  const run = {
    run_id: fields.run_id,
    interaction_id: interactionId,
    rule_version: interaction.rule_version,
    rules_hash: computeRulesHash(interaction),
    computed_at: fields.computed_at,
    settlement_at: fields.settlement_at ?? fields.computed_at,
    kind: fields.kind,
    status: fields.status,
    supersedes: fields.supersedes ?? null,
    input_window: fields.input_window ?? { received_after: null, received_before: fields.computed_at },
    adjustments_applied: appliedIds,
    raw: { ballots: rawTally(record, interactionId), note: '原始口径：全部投票事件，重算不篡改历史' },
    adjusted:
      fields.kind === 'official_recomputation' || fields.include_adjusted
        ? {
            ballots: adjustedTally(record, interactionId),
            late_separately_recorded: classification.late,
            note: '调整口径：按锁定规则与调整台账剔除异常后的有效票',
          }
        : null,
  };
  return Object.freeze(run);
}

/**
 * 把计票运行追加进记录，返回新记录（原记录保持冻结不变）。
 * 校验：run_id 唯一、规则版本与指纹匹配互动、运行内数字与现场重算一致。
 */
export function appendRun(record, run) {
  if ((record.tally_runs ?? []).some((r) => r.run_id === run.run_id)) {
    throw new Error(`计票运行已存在，追加式台账禁止覆盖: ${run.run_id}`);
  }
  const interaction = byId(record.interactions, 'interaction_id').get(run.interaction_id);
  if (run.rule_version !== interaction.rule_version) {
    throw new Error(`运行 ${run.run_id} 规则版本与互动锁定版本不一致`);
  }
  verifyRulesHash(interaction, run.rules_hash);

  const expectedRaw = rawTally(record, run.interaction_id);
  if (JSON.stringify(run.raw.ballots) !== JSON.stringify(expectedRaw)) {
    throw new Error(`运行 ${run.run_id} 原始口径与投票事件重算结果不一致`);
  }
  if (run.adjusted) {
    const expectedAdjusted = adjustedTally(record, run.interaction_id);
    if (JSON.stringify(run.adjusted.ballots) !== JSON.stringify(expectedAdjusted)) {
      throw new Error(`运行 ${run.run_id} 调整口径与台账重算结果不一致`);
    }
  }

  const next = structuredClone(record);
  next.tally_runs = [...(next.tally_runs ?? []), structuredClone(run)];
  return Object.freeze(next);
}

/**
 * 重算前后对比已发布内容：任何已发布版本的指纹都不得变化。
 * 统计重算只能新增运行与新版本，不能修改已发布章节或镜头。
 */
export function assertPublishedVersionsImmutable(before, after) {
  const publishedOf = (rec) =>
    (rec.content_units ?? []).flatMap((u) =>
      (u.versions ?? []).filter((v) => v.state === 'published').map((v) => [v.version_id, v.content_hash]),
    );
  const beforeMap = new Map(publishedOf(before));
  const afterMap = new Map(publishedOf(after));
  for (const [versionId, hash] of beforeMap) {
    if (!afterMap.has(versionId)) {
      throw new Error(`已发布版本 ${versionId} 在重算后消失`);
    }
    if (afterMap.get(versionId) !== hash) {
      throw new Error(`已发布版本 ${versionId} 内容指纹在重算后被修改`);
    }
  }
  for (const versionId of afterMap.keys()) {
    if (!beforeMap.has(versionId)) {
      // 允许新增发布版本，只禁止改动旧版本。
      continue;
    }
  }
  return true;
}
