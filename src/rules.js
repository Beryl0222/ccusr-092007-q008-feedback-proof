import { createHash } from 'node:crypto';

/**
 * 互动规则模块：规则必须在互动开始前锁定，锁定后不可修改；
 * 参与资格、权重、截止时间与编辑不可让渡边界是规则的必备部分。
 */

export const REQUIRED_RULE_FIELDS = [
  'eligibility',
  'closes_at',
  'editorial_boundaries',
];

/** 计算规则指纹：对规范化后的规则内容取哈希，锁定后任一字段被篡改都会改变指纹。 */
export function computeRulesHash(interaction) {
  const material = {
    interaction_id: interaction.interaction_id,
    starts_at: interaction.starts_at,
    closes_at: interaction.closes_at,
    eligibility: interaction.eligibility,
    editorial_boundaries: interaction.editorial_boundaries,
    options: interaction.options,
  };
  return 'sha256:' + createHash('sha256')
    .update(JSON.stringify(material, Object.keys(material).sort()))
    .digest('hex');
}

/**
 * 校验规则在互动开始前已经锁定且内容完整。
 * 规则缺失必备字段、未锁定、或锁定晚于开始时间，一律拒绝。
 */
export function assertRulesLockedBeforeStart(interaction, nowIso) {
  for (const field of REQUIRED_RULE_FIELDS) {
    if (interaction[field] === undefined || interaction[field] === null) {
      throw new Error(`互动 ${interaction.interaction_id} 缺少开始前必须锁定的规则字段: ${field}`);
    }
  }
  if (!interaction.locked_at || !interaction.locked_by || !interaction.rule_version) {
    throw new Error(`互动 ${interaction.interaction_id} 缺少锁定时间、锁定人或规则版本`);
  }
  if (Date.parse(interaction.locked_at) > Date.parse(interaction.starts_at)) {
    throw new Error(`互动 ${interaction.interaction_id} 规则锁定晚于开始时间`);
  }
  const weights = interaction.eligibility.weight_classes;
  if (!Array.isArray(weights) || weights.length === 0) {
    throw new Error(`互动 ${interaction.interaction_id} 未定义参与权重`);
  }
  for (const w of weights) {
    if (!Number.isFinite(w.weight) || w.weight < 0) {
      throw new Error(`互动 ${interaction.interaction_id} 权重非法: ${JSON.stringify(w)}`);
    }
  }
  if (
    !Array.isArray(interaction.editorial_boundaries.non_delegable)
    || interaction.editorial_boundaries.non_delegable.length === 0
  ) {
    throw new Error(`互动 ${interaction.interaction_id} 未声明编辑不可让渡边界`);
  }
  if (nowIso && Date.parse(interaction.starts_at) > Date.parse(nowIso)) {
    throw new Error(`互动 ${interaction.interaction_id} 尚未开始`);
  }
  return true;
}

/** 校验规则指纹：记录中的指纹必须与规则内容重算结果一致。 */
export function verifyRulesHash(interaction, storedHash) {
  const recomputed = computeRulesHash(interaction);
  if (storedHash !== recomputed) {
    throw new Error(`互动 ${interaction.interaction_id} 规则指纹不一致，规则可能被事后篡改`);
  }
  return true;
}

/**
 * 提议的创作动作是否越过编辑不可让渡边界。
 * 调用方在 proposedAction.boundary_key 中显式声明所涉边界；
 * 热度/投票结果不能自动覆盖该边界（heat_is_not_a_command）。
 */
export function crossesNonDelegableBoundary(interaction, proposedAction) {
  const boundaries = interaction.editorial_boundaries.non_delegable;
  if (proposedAction.boundary_key) {
    return boundaries.includes(proposedAction.boundary_key);
  }
  return false;
}
