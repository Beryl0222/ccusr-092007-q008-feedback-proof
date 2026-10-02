import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecord } from '../src/contracts.js';
import {
  adjustedTally,
  appendRun,
  assertPublishedVersionsImmutable,
  buildRun,
  rawTally,
} from '../src/tally.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'audience_feedback.json');
const POLL = 'poll-ep201-subplot';

async function load() {
  return loadRecord(fixturePath);
}

test('原始口径重现直播现场 8:3 的高声量（迟到票不计入）', async () => {
  const record = await load();
  assert.deepEqual(rawTally(record, POLL), { 'opt-cut': 8, 'opt-keep': 3 });
});

test('调整口径剔除异常后为 0:3，高声量确系操纵与失效资格', async () => {
  const record = await load();
  assert.deepEqual(adjustedTally(record, POLL), { 'opt-cut': 0, 'opt-keep': 3 });
});

test('样例中两次计票运行与现场重算一致，且正式运行取代临时运行', async () => {
  const record = await load();
  const provisional = record.tally_runs.find((r) => r.run_id === 'tr-001');
  const official = record.tally_runs.find((r) => r.run_id === 'tr-002');
  assert.equal(provisional.status, 'provisional');
  assert.equal(official.status, 'final');
  assert.equal(official.supersedes, 'tr-001');
  assert.deepEqual(provisional.raw.ballots, { 'opt-cut': 8, 'opt-keep': 3 });
  assert.deepEqual(official.adjusted.ballots, { 'opt-cut': 0, 'opt-keep': 3 });
  assert.deepEqual(official.adjusted.late_separately_recorded, ['v-201']);
});

test('重算只能追加新运行，不能覆盖已有运行', async () => {
  const record = await load();
  const rerun = buildRun(record, POLL, {
    run_id: 'tr-003',
    computed_at: '2026-09-21T08:00:00+08:00',
    kind: 'official_recomputation',
    status: 'final',
    supersedes: 'tr-002',
    adjustments_applied: record.adjustments_ledger.map((a) => a.adjustment_id),
  });
  const next = appendRun(record, rerun);
  assert.equal(next.tally_runs.length, record.tally_runs.length + 1);
  // 原记录保持不变
  assert.equal(record.tally_runs.length, 2);
  assert.throws(() => appendRun(record, record.tally_runs[0]), /追加式台账禁止覆盖/);
});

test('运行声明的调整必须真实存在于台账', async () => {
  const record = await load();
  assert.throws(
    () =>
      buildRun(record, POLL, {
        run_id: 'tr-bad',
        computed_at: '2026-09-21T08:00:00+08:00',
        kind: 'official_recomputation',
        status: 'final',
        adjustments_applied: ['adj-ghost'],
      }),
    /台账中不存在的调整/,
  );
});

test('篡改运行内数字会被重算一致性校验拦下', async () => {
  const record = await load();
  const fakeRun = structuredClone(record.tally_runs[1]);
  fakeRun.run_id = 'tr-fake';
  fakeRun.raw.ballots = { 'opt-cut': 99, 'opt-keep': 0 };
  assert.throws(() => appendRun(record, fakeRun), /原始口径与投票事件重算结果不一致/);
});

test('统计重算不修改已发布章节或镜头：新增版本允许、改动旧版本被拒', async () => {
  const record = await load();
  const withDraft = structuredClone(record);
  withDraft.content_units[1].versions.push({
    version_id: 'ep-202-v2',
    state: 'private_draft',
    created_at: '2026-09-21T09:00:00+08:00',
    access_list: ['ed-01'],
    scenes: [],
  });
  assert.equal(assertPublishedVersionsImmutable(record, withDraft), true);

  const tamperedPublished = structuredClone(record);
  tamperedPublished.content_units[0].versions = tamperedPublished.content_units[0].versions.map((v) =>
    v.version_id === 'ep-201-v1' ? { ...v, content_hash: 'sha256:deadbeef' } : v,
  );
  assert.throws(
    () => assertPublishedVersionsImmutable(record, tamperedPublished),
    /内容指纹在重算后被修改/,
  );
});
