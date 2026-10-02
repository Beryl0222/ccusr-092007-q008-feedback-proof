import { migrate, validateV2, createActivity, freezeRules } from '../src/contracts.js';

export function emptyRecord() {
  return migrate({
    schema_version: 1,
    record_id: 'test-001',
    domain: 'feedback_proof',
    occurred_at: '2026-09-20T09:00:00+08:00',
    revision: 1,
    source: '测试',
  });
}

export const baseRules = {
  eligible_audience: ['paid_subscriber', 'single_ticket'],
  default_weight: 1,
  weight_overrides: { paid_subscriber: 2 },
  editor_non_delegable: ['最终剪辑决定权', '续篇立项决定权'],
};

/** 造一场已冻结、可收票的活动并装进记录。 */
export function recordWithActivity(overrides = {}) {
  const activity = createActivity({
    activity_id: overrides.activity_id ?? 'act-1',
    title: '测试投票',
    scheduled_start_at: overrides.start ?? '2026-09-19T20:00:00+08:00',
    deadline_at: overrides.deadline ?? '2026-09-19T22:00:00+08:00',
    rules: { ...baseRules, ...(overrides.rules ?? {}) },
  });
  const frozen = freezeRules(activity, overrides.frozen_at ?? '2026-09-18T18:00:00+08:00');
  const record = structuredClone(emptyRecord());
  record.activities.push(frozen);
  return validateV2(record);
}
