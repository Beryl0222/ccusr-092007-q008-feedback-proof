import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecord, recordFromObject } from '../src/contracts.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'audience_feedback.json');

test('业务样例符合当前数据合同（v2，保留 v1 标识）', async () => {
  const record = await loadRecord(fixturePath);
  assert.equal(record.schema_version, 2);
  assert.equal(record.record_id, 'sample-008');
  assert.equal(record.domain, 'feedback_proof');
  assert.ok(record.revision > 0);
  assert.ok(record.occurred_at);
  assert.ok(record.source);
});

test('记录被深度冻结，任何历史对象不可原地改写', async () => {
  const record = await loadRecord(fixturePath);
  assert.throws(() => {
    record.interactions[0].closes_at = '2026-09-18T23:00:00+08:00';
  }, TypeError);
  assert.throws(() => {
    record.tally_runs.push({});
  }, TypeError);
});

test('拒绝不支持的 schema_version', () => {
  assert.throws(
    () => recordFromObject({ schema_version: 99, record_id: 'x' }),
    /不支持的 schema_version/,
  );
});

test('缺少必要标识时拒绝', () => {
  assert.throws(
    () => recordFromObject({ schema_version: 2 }),
    /数据合同缺少必要标识/,
  );
});
