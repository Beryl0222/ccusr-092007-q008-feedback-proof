import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecord } from '../src/contracts.js';
import {
  canReadContentVersion,
  canReadResponse,
  promiseStatusForSubscriber,
  transitionPromise,
  validatePromise,
  validateResponses,
  visibleResponses,
} from '../src/responses.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'audience_feedback.json');

async function load() {
  return loadRecord(fixturePath);
}

test('创作者回应全部为 adopted/partially_adopted/rejected 且附理由', async () => {
  const record = await load();
  assert.equal(validateResponses(record), true);
  const rejected = record.creator_responses.find((r) => r.response_id === 'rp-001');
  assert.equal(rejected.decision, 'rejected');
  assert.match(rejected.rationale, /刷票/);
});

test('缺少理由的回应被拒绝', async () => {
  const record = await load();
  const mutated = structuredClone(record);
  mutated.creator_responses[0].rationale = '   ';
  assert.throws(() => validateResponses(mutated), /必须记录理由/);
});

test('私人草稿只对获准编辑开放，订阅者与其他人员不可见', async () => {
  const record = await load();
  const draft = record.creator_responses.find((r) => r.response_id === 'rp-004');
  assert.equal(draft.visibility, 'private_draft');
  assert.equal(canReadResponse(draft, { actor_id: 'ed-02', role: 'editor' }), true);
  assert.equal(canReadResponse(draft, { actor_id: 'ed-99', role: 'editor' }), false);
  assert.equal(canReadResponse(draft, { actor_id: 'id-005', role: 'viewer', is_subscriber: true }), false);

  const draftVersion = record.content_units.find((u) => u.content_id === 'ep-202').versions[0];
  assert.equal(canReadContentVersion(draftVersion, { actor_id: 'cr-01' }), true);
  assert.equal(canReadContentVersion(draftVersion, { actor_id: 'id-005' }), false);
});

test('订阅者可见正式回应，但可见列表过滤掉私人草稿', async () => {
  const record = await load();
  const subscriber = { actor_id: 'id-005', role: 'viewer', is_subscriber: true };
  const visible = visibleResponses(record, subscriber).map((r) => r.response_id);
  assert.ok(visible.includes('rp-001'));
  assert.ok(!visible.includes('rp-004'));
});

test('对订阅者的承诺状态可核验：已履行承诺附证据，未履行承诺如实显示 open', async () => {
  const record = await load();
  const open = promiseStatusForSubscriber(record.subscriber_promises.find((p) => p.promise_id === 'pr-001'));
  assert.equal(open.status, 'open');
  assert.equal(open.verifiable.evidence, null);

  const fulfilled = promiseStatusForSubscriber(record.subscriber_promises.find((p) => p.promise_id === 'pr-002'));
  assert.equal(fulfilled.status, 'fulfilled');
  assert.equal(fulfilled.verifiable.evidence, 'post-2026-09-20-audit');
});

test('承诺状态迁移追加留痕，非法迁移与无证据履行被拒绝', async () => {
  const record = await load();
  const open = record.subscriber_promises.find((p) => p.promise_id === 'pr-001');
  assert.equal(validatePromise(open), true);

  assert.throws(
    () => transitionPromise(open, 'fulfilled', { at: '2026-10-01T00:00:00+08:00', by: 'cr-01' }),
    /履行必须同时登记可核验证据|非法状态迁移/,
  );

  const inProgress = transitionPromise(open, 'in_progress', {
    at: '2026-10-01T00:00:00+08:00',
    by: 'cr-01',
    note: '番外开始写作',
  });
  assert.equal(inProgress.status, 'in_progress');
  assert.equal(inProgress.history.length, open.history.length + 1);

  const done = transitionPromise(inProgress, 'fulfilled', {
    at: '2026-11-01T00:00:00+08:00',
    by: 'cr-01',
    note: '番外上线',
    evidence_content_id: 'extra-007',
    evidence_hash: 'sha256:abc123',
  });
  assert.equal(done.status, 'fulfilled');
  assert.equal(validatePromise(done), true);
});

test('讨论不等于承诺：未登记进 subscriber_promises 的网文讨论不产生承诺状态', async () => {
  const record = await load();
  const registered = new Set(record.subscriber_promises.map((p) => p.promise_id));
  // cm-005 对续篇的追问仅作为意见聚类 oc-003 存在，没有对应承诺
  const cluster = record.opinion_clusters.find((c) => c.cluster_id === 'oc-003');
  assert.ok(cluster.entries.some((e) => e.entry_ref === 'comment:cm-005'));
  assert.ok(!registered.has('cm-005'));
});
