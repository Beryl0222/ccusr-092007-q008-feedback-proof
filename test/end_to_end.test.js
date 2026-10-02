import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecord } from '../src/contracts.js';
import { assertRulesLockedBeforeStart, verifyRulesHash } from '../src/rules.js';
import { classifyVotes, validateAdjustments } from '../src/ledger.js';
import {
  adjustedTally,
  appendRun,
  assertPublishedVersionsImmutable,
  buildRun,
  rawTally,
} from '../src/tally.js';
import { assertChangeIsEditoriallyGrounded, compareRun, traceChange } from '../src/provenance.js';
import { promiseStatusForSubscriber, validatePromise, validateResponses } from '../src/responses.js';
import { validateSettlements } from '../src/rewards.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'audience_feedback.json');
const POLL = 'poll-ep201-subplot';

test('端到端：规则先行 → 原始高声量 → 异常剔除 → 重算不碰已发布内容 → 新决定进新版本 → 承诺与计酬可核验', async () => {
  // 0) 记录可读、全部子结构自洽
  const record = await loadRecord(fixturePath);
  const interaction = record.interactions[0];

  // 1) 互动开始前资格/权重/截止/不可让渡边界已锁定且指纹可验
  assert.equal(assertRulesLockedBeforeStart(interaction), true);
  assert.equal(verifyRulesHash(interaction, interaction.rules_hash), true);

  // 2) 原始口径重现直播现场：删除 8、保留 3
  assert.deepEqual(rawTally(record, POLL), { 'opt-cut': 8, 'opt-keep': 3 });

  // 3) 五类异常 + 迟到全部有台账依据
  assert.equal(validateAdjustments(record, POLL).valid, true);
  const cls = classifyVotes(record, POLL);
  assert.deepEqual(cls.late, ['v-201']);

  // 4) 剔除后删除票归零，付费观众的刷票质疑成立
  assert.deepEqual(adjustedTally(record, POLL), { 'opt-cut': 0, 'opt-keep': 3 });
  const view = compareRun(record, 'tr-002');
  assert.equal(view.per_option.find((r) => r.option_id === 'opt-cut').removed, 8);

  // 5) 再次重算：只能追加新运行，且已发布 ep-201-v1 指纹不变
  const rerun = buildRun(record, POLL, {
    run_id: 'tr-e2e-rerun',
    computed_at: '2026-09-22T08:00:00+08:00',
    kind: 'official_recomputation',
    status: 'final',
    supersedes: 'tr-002',
    adjustments_applied: record.adjustments_ledger.map((a) => a.adjustment_id),
  });
  const next = appendRun(record, rerun);
  assert.equal(assertPublishedVersionsImmutable(record, next), true);
  assert.deepEqual(next.tally_runs.at(-1).adjusted.ballots, { 'opt-cut': 0, 'opt-keep': 3 });

  // 6) 恢复角色的内容变化可一路追溯到 tr-002、规则版本与人工决定；热度不是命令
  const trace = traceChange(record, 'ch-ep202-restore');
  assert.equal(trace.basis_runs[0].run_id, 'tr-002');
  assert.equal(trace.to_version_id, 'ep-202-v1-draft');
  assert.equal(trace.creator_response.decision, 'partially_adopted');
  assert.equal(assertChangeIsEditoriallyGrounded(record, 'ch-ep202-restore'), true);

  // 7) 回应、承诺、计酬全部可核验
  assert.equal(validateResponses(record), true);
  for (const p of record.subscriber_promises) assert.equal(validatePromise(p), true);
  assert.equal(promiseStatusForSubscriber(
    record.subscriber_promises.find((p) => p.promise_id === 'pr-002'),
  ).status, 'fulfilled');
  assert.equal(validateSettlements(record), true);
});
