import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecordV2 } from '../src/contracts.js';
import { diffSnapshots } from '../src/feedback.js';
import { traceContentChange, publicPledgeStatus, readPrivateDraft, previewSettlements } from '../src/editorial.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, '..', 'fixtures', 'audience_feedback.json');

async function load() {
  return loadRecordV2(fixture);
}

test('业务样例：规则在开播前冻结且边界不可让渡', async () => {
  const rec = await load();
  const a = rec.activities.find((x) => x.activity_id === 'live-20260919-ep07');
  assert.equal(a.rules_status, 'frozen');
  assert.ok(Date.parse(a.rules_snapshot.frozen_at) < Date.parse(a.scheduled_start_at));
  assert.equal(a.rules_snapshot.can_audience_veto, false);
  assert.equal(a.rules_snapshot.heat_is_command, false);
  assert.ok(a.rules_snapshot.editor_non_delegable.includes('续集/续篇立项决定权'));
});

test('业务样例：撤票与退款票不进任何计票；迟到 40 票被隔离，未翻转结论', async () => {
  const rec = await load();
  const a = rec.activities.find((x) => x.activity_id === 'live-20260919-ep07');
  assert.equal(a.votes.find((v) => v.vote_id === 'v-20').status, 'withdrawn');
  assert.equal(a.votes.find((v) => v.vote_id === 'v-05').status, 'refunded');
  assert.ok(a.late_arrivals.find((l) => l.late_id === 'l-01').disposition === 'quarantined');
  const raw = a.tally_snapshots.find((s) => s.snapshot_id === 's-raw-20260919');
  // 迟到 40 票完全不在任何快照里
  assert.ok(!raw.excluded_vote_ids.includes('l-01'));
  assert.equal(raw.tally.options.cut_subplot.ballots, 9); // 1 真实 cut + 8 协同；退款票已剔除
});

test('业务样例：原始结果与排除异常结果并排，刷票排除后排名翻转', async () => {
  const rec = await load();
  const a = rec.activities.find((x) => x.activity_id === 'live-20260919-ep07');
  const diff = diffSnapshots(a, 's-raw-20260919', 's-adj-20260920');
  assert.equal(diff.winner_changed, true);
  assert.deepEqual(a.tally_snapshots.find((s) => s.kind === 'raw').ranking, ['cut_subplot', 'keep_subplot']);
  assert.deepEqual(a.tally_snapshots.find((s) => s.kind === 'adjusted').ranking, ['keep_subplot', 'cut_subplot']);
  // 8 张协同票是两份结果之间的唯一差异
  assert.equal(diff.excluded_between.length, 8);
  assert.equal(diff.per_option.cut_subplot.delta, -8);
  // 原始快照仍然原样保留，重算没有覆盖它
  assert.equal(a.tally_snapshots.find((s) => s.kind === 'raw').excluded_vote_ids.length, 0);
});

test('业务样例：重算不修改已发布章节/镜头；两次决定分别引用原始与调整快照', async () => {
  const rec = await load();
  const v1 = rec.content_versions.find((c) => c.version_id === 'shot-ep07-v1');
  assert.equal(v1.status, 'published');
  // 第7集成片（发布在前、刷票复核在后）没有被回改，变化体现在第8集新版本
  const t7 = traceContentChange(rec, 'shot-ep07-v2');
  const t8 = traceContentChange(rec, 'shot-ep08-v1');
  assert.equal(t7.basis[0].based_on.kind, 'raw');
  assert.equal(t7.basis[0].outcome, 'partially_adopted');
  assert.equal(t8.basis[0].based_on.kind, 'adjusted');
  assert.equal(t8.basis[0].outcome, 'adopted');
});

test('业务样例：对订阅者的正式承诺可核验，讨论区续篇诉求未被登记为承诺', async () => {
  const rec = await load();
  const a = rec.activities.find((x) => x.activity_id === 'live-20260919-ep07');
  const view = publicPledgeStatus(rec, a.activity_id, 'p-01');
  assert.equal(view.status, 'fulfilled');
  assert.equal(view.verification[0].version_id, 'shot-ep08-v1');
  assert.deepEqual(view.history.map((h) => h.status), ['made', 'in_progress', 'fulfilled']);
  // t-02 的“求续篇”只停留在评论主题，没有生成任何 pledge
  assert.equal(a.pledges.length, 1);
});

test('业务样例：私人草稿只对获准编辑开放', async () => {
  const rec = await load();
  assert.equal(readPrivateDraft(rec, 'draft-01', 'chief_zhao').owner, 'writer_lu');
  assert.throws(() => readPrivateDraft(rec, 'draft-01', 'paid_user_001'), /无权访问/);
});

test('业务样例：同一意见跨三个入口只计酬一次，重复入口合并列明', async () => {
  const rec = await load();
  const paid = rec.reward_settlements.find((s) => s.settlement_id === 'st-01');
  assert.equal(paid.status, 'paid');
  assert.deepEqual([...paid.source_refs].sort(), ['comment:c-01', 'comment:c-03', 'late:l-02']);
  // 若运营再就同一意见（外部微博入口）发起结算，预检必须判定为重复、不可支付
  const preview = previewSettlements(rec, [
    { settlement_id: 'st-dup', opinion_fingerprint: paid.opinion_fingerprint, source_refs: ['external:weibo:123'] },
  ]);
  assert.equal(preview[0].payable, false);
  assert.equal(preview[0].duplicate_of_paid, 'st-01');
});
