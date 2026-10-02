import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecord } from '../src/contracts.js';
import {
  assertChangeIsEditoriallyGrounded,
  changesBasedOnRun,
  compareRun,
  traceChange,
} from '../src/provenance.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'audience_feedback.json');

async function load() {
  return loadRecord(fixturePath);
}

test('编辑可并排查看原始与调整后差异：删除票从 8 降到 0，差异逐条可核', async () => {
  const record = await load();
  const view = compareRun(record, 'tr-002');
  const cut = view.per_option.find((r) => r.option_id === 'opt-cut');
  const keep = view.per_option.find((r) => r.option_id === 'opt-keep');
  assert.deepEqual({ raw: cut.raw, adjusted: cut.adjusted, removed: cut.removed }, { raw: 8, adjusted: 0, removed: 8 });
  assert.deepEqual({ raw: keep.raw, adjusted: keep.adjusted, removed: keep.removed }, { raw: 3, adjusted: 3, removed: 0 });
  assert.equal(view.adjustments_applied.length, 6);
  assert.deepEqual(view.late_separately_recorded, ['v-201']);
});

test('临时运行 tr-001 只有原始口径，对比视图如实显示无调整口径', async () => {
  const record = await load();
  const view = compareRun(record, 'tr-001');
  assert.equal(view.adjusted, null);
  assert.equal(view.status, 'provisional');
});

test('可追溯内容变化实际依据的计票运行、规则版本与调整依据', async () => {
  const record = await load();
  const trace = traceChange(record, 'ch-ep202-restore');
  assert.equal(trace.basis_runs[0].run_id, 'tr-002');
  assert.equal(trace.basis_runs[0].rule_version, 'rv-2026-09-18-a');
  assert.ok(trace.basis_runs[0].rules_hash.startsWith('sha256:'));
  assert.deepEqual(trace.basis_runs[0].adjusted, { 'opt-cut': 0, 'opt-keep': 3 });
  assert.equal(trace.creator_response.decision, 'partially_adopted');
  assert.equal(trace.editorial_decision.decision_id, 'edec-002');
  const adjKinds = new Set(trace.basis_runs[0].adjustments.map((a) => a.kind));
  assert.ok(adjKinds.has('coordinated_cluster'));
});

test('反向追溯：tr-002 支撑的变化与 tr-001 区分', async () => {
  const record = await load();
  assert.deepEqual(changesBasedOnRun(record, 'tr-002'), ['ch-ep202-restore']);
  assert.deepEqual(changesBasedOnRun(record, 'tr-001'), ['ch-ep201-cut']);
});

test('仅依据被取代临时结果、且未纠正的编辑决定不合规（热度不是命令）', async () => {
  const record = await load();
  // ch-ep201-cut 依据 tr-001，但 edec-001 已标记 superseded_by=edec-002，故当前样例合规
  assert.equal(assertChangeIsEditoriallyGrounded(record, 'ch-ep201-cut'), true);

  const mutated = structuredClone(record);
  const oldDecision = mutated.editorial_decisions.find((d) => d.decision_id === 'edec-001');
  oldDecision.superseded_by = null;
  assert.throws(
    () => assertChangeIsEditoriallyGrounded(mutated, 'ch-ep201-cut'),
    /仅依据已被正式重算取代的临时结果/,
  );
});

test('没有人工编辑决定的变化被拒绝', async () => {
  const record = await load();
  const mutated = structuredClone(record);
  mutated.content_changes[1].editorial_decision_ref = null;
  assert.throws(
    () => assertChangeIsEditoriallyGrounded(mutated, 'ch-ep202-restore'),
    /热度不得自动成为创作命令/,
  );
});
