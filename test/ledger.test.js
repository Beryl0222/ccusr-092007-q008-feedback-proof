import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecord } from '../src/contracts.js';
import {
  classifyVotes,
  validateAdjustments,
  weightOf,
} from '../src/ledger.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'audience_feedback.json');
const POLL = 'poll-ep201-subplot';

async function load() {
  return loadRecord(fixturePath);
}

test('台账五类异常处置全部有规则条款、证据、决定人与决定时间', async () => {
  const record = await load();
  const result = validateAdjustments(record, POLL);
  assert.equal(result.valid, true);
  const kinds = new Set(record.adjustments_ledger.map((a) => a.kind));
  for (const kind of [
    'identity_dedup',
    'refund_exclusion',
    'ineligible_weight',
    'withdrawal',
    'coordinated_cluster',
    'late_data',
  ]) {
    assert.ok(kinds.has(kind), `缺少 ${kind} 的处理依据`);
  }
});

test('票被正确归类：有效 3 票、迟到单列、其余按台账排除', async () => {
  const record = await load();
  const c = classifyVotes(record, POLL);
  assert.deepEqual(c.counted.sort(), ['v-002', 'v-005', 'v-302']);
  assert.deepEqual(c.late, ['v-201']);
  const excludedKinds = new Set(c.excluded.map((e) => e.kind));
  assert.ok(excludedKinds.has('coordinated_cluster'));
  assert.ok(excludedKinds.has('refund_exclusion'));
  assert.ok(excludedKinds.has('identity_dedup'));
  assert.ok(excludedKinds.has('withdrawal'));
  assert.ok(excludedKinds.has('ineligible_weight'));
  // 迟到票绝不能混进被排除或有效集合
  assert.ok(!c.counted.includes('v-201'));
  assert.ok(!c.excluded.some((e) => e.vote_id === 'v-201'));
});

test('同一参与者跨平台两票：去重只保留截止前最后一票', async () => {
  const record = await load();
  const c = classifyVotes(record, POLL);
  assert.ok(!c.counted.includes('v-001'));
  assert.ok(c.counted.includes('v-002'));
  const dedup = record.adjustments_ledger.find((a) => a.kind === 'identity_dedup');
  assert.equal(dedup.kept_vote_id, 'v-002');
  assert.equal(dedup.evidence_ref, 'doc-merge-001');
});

test('无台账标记但实际晚于截止时间的票，仍自动进入迟到通道', async () => {
  const record = await load();
  const mutated = structuredClone(record);
  mutated.adjustments_ledger = mutated.adjustments_ledger.filter((a) => a.kind !== 'late_data');
  const c = classifyVotes(mutated, POLL);
  assert.deepEqual(c.late, ['v-201']);
  assert.ok(!c.counted.includes('v-201'));
});

test('台账不允许一票被重复排除', async () => {
  const record = await load();
  const mutated = structuredClone(record);
  mutated.adjustments_ledger.push({
    adjustment_id: 'adj-dup',
    interaction_id: POLL,
    kind: 'withdrawal',
    effect: 'exclude_vote',
    target_vote_ids: ['v-003'],
    basis: '重复排除测试',
    rule_clause: 'closes_at',
    evidence_ref: 'x',
    decided_by: 'ed-02',
    decided_at: '2026-09-20T09:00:00+08:00',
  });
  assert.throws(() => validateAdjustments(mutated, POLL), /重复排除/);
});

test('调整依据的决定时间不得早于截止时间', async () => {
  const record = await load();
  const mutated = structuredClone(record);
  mutated.adjustments_ledger[0].decided_at = '2026-09-18T20:00:00+08:00';
  assert.throws(() => validateAdjustments(mutated, POLL), /决定时间早于截止时间/);
});

test('权重按锁定规则解析，游客权重为 0', async () => {
  const record = await load();
  const interaction = record.interactions[0];
  assert.equal(weightOf(interaction, { tier: 'paid_subscriber' }), 1);
  assert.equal(weightOf(interaction, { tier: 'guest' }), 0);
  assert.throws(() => weightOf(interaction, { tier: 'vip_king' }), /不在锁定权重表中/);
});
