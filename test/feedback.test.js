import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addVote,
  withdrawVote,
  refundVote,
  addCommentThread,
  addComment,
  flagAnomaly,
  addLateArrival,
  computeTallySnapshot,
  diffSnapshots,
  aggregateCommentThemes,
  makeFingerprint,
  addIdentityMerge,
} from '../src/feedback.js';
import { recordWithActivity } from './helpers.js';

const AID = 'act-1';

function vote(rec, overrides = {}) {
  return addVote(rec, {
    activity_id: AID,
    vote_id: overrides.vote_id ?? 'v1',
    voter_account: overrides.voter_account ?? 'u1',
    segment: overrides.segment ?? 'single_ticket',
    option: overrides.option ?? 'A',
    submitted_at: overrides.submitted_at ?? '2026-09-19T20:05:00+08:00',
  });
}

test('票重由冻结规则决定，票上自带权重无效；不在资格内被拒', () => {
  let rec = recordWithActivity();
  rec = vote(rec, { vote_id: 'v1', segment: 'paid_subscriber', option: 'A' });
  rec = vote(rec, { vote_id: 'v2', voter_account: 'u2', segment: 'single_ticket', option: 'A' });
  const v1 = rec.activities[0].votes.find((v) => v.vote_id === 'v1');
  assert.equal(v1.weight, 2); // 付费订阅权重来自快照
  assert.throws(() => vote(rec, { vote_id: 'v3', segment: 'anonymous_guest' }), /参与资格/);
});

test('撤票与退款都留痕且不参与计票', () => {
  let rec = recordWithActivity();
  rec = vote(rec, { vote_id: 'v1', option: 'A' });
  rec = vote(rec, { vote_id: 'v2', voter_account: 'u2', option: 'B' });
  rec = withdrawVote(rec, { activity_id: AID, vote_id: 'v1', withdrawn_at: '2026-09-19T21:00:00+08:00' });
  rec = refundVote(rec, { activity_id: AID, vote_id: 'v2', refund_id: 'rf-1', refunded_at: '2026-09-19T21:05:00+08:00' });
  const a = rec.activities[0];
  assert.equal(a.votes.find((v) => v.vote_id === 'v1').status, 'withdrawn');
  assert.equal(a.votes.find((v) => v.vote_id === 'v2').refund_id, 'rf-1');
  rec = computeTallySnapshot(rec, { activity_id: AID, snapshot_id: 's1', computed_at: '2026-09-19T22:05:00+08:00', kind: 'raw' });
  const snap = rec.activities[0].tally_snapshots[0];
  assert.equal(snap.tally.ballot_count, 0);
});

test('撤票状态单向流转，不能重复撤票', () => {
  let rec = recordWithActivity();
  rec = vote(rec, { vote_id: 'v1' });
  rec = withdrawVote(rec, { activity_id: AID, vote_id: 'v1', withdrawn_at: '2026-09-19T21:00:00+08:00' });
  assert.throws(() => withdrawVote(rec, { activity_id: AID, vote_id: 'v1', withdrawn_at: '2026-09-19T21:01:00+08:00' }), /单向/);
});

test('超过截止时间的票不能直接入票，必须走迟到数据并被隔离或仅用于主题', () => {
  let rec = recordWithActivity();
  assert.throws(() => vote(rec, { vote_id: 'vLate', submitted_at: '2026-09-19T22:30:00+08:00' }), /迟到/);
  rec = addLateArrival(rec, {
    activity_id: AID,
    late_id: 'l1',
    kind: 'vote',
    payload: { option: 'A', count: 99 },
    observed_at: '2026-09-19T22:30:00+08:00',
    disposition: 'quarantined',
    basis: '渠道回传迟到 30 分钟',
  });
  assert.throws(
    () => addLateArrival(rec, { activity_id: AID, late_id: 'l2', kind: 'vote', payload: {}, observed_at: '2026-09-19T22:31:00+08:00', disposition: 'quarantined' }),
    /basis/,
  );
});

test('跨平台合并必须有凭证；重复票撤票后只认 canonical 票', () => {
  let rec = recordWithActivity();
  assert.throws(
    () => addIdentityMerge(rec, { merge_id: 'm1', account_refs: ['only-one'], canonical_account: 'only-one', merged_at: '2026-09-19T20:10:00+08:00', basis: 'x' }),
    /至少要列出两个/,
  );
  rec = addIdentityMerge(rec, {
    merge_id: 'm1',
    account_refs: ['platA:u1', 'platB:u1b'],
    canonical_account: 'platA:u1',
    merged_at: '2026-09-19T20:10:00+08:00',
    basis: '已验证的相同实名绑定凭证',
  });
  rec = addVote(rec, { activity_id: AID, vote_id: 'v1', voter_account: 'platA:u1', segment: 'single_ticket', option: 'A', submitted_at: '2026-09-19T20:05:00+08:00' });
  rec = addVote(rec, { activity_id: AID, vote_id: 'vDup', voter_account: 'platB:u1b', segment: 'single_ticket', option: 'A', submitted_at: '2026-09-19T20:06:00+08:00', merge_id: 'm1' });
  rec = withdrawVote(rec, { activity_id: AID, vote_id: 'vDup', withdrawn_at: '2026-09-19T20:11:00+08:00' });
  rec = computeTallySnapshot(rec, { activity_id: AID, snapshot_id: 's1', computed_at: '2026-09-19T22:05:00+08:00', kind: 'raw' });
  assert.equal(rec.activities[0].tally_snapshots[0].tally.ballot_count, 1);
  // 引用不存在的合并要被校验挡住
  assert.throws(
    () => addVote(rec, { activity_id: AID, vote_id: 'vX', voter_account: 'x', segment: 'single_ticket', option: 'A', submitted_at: '2026-09-19T20:40:00+08:00', merge_id: 'nope' }),
    /未知合并/,
  );
});

test('原始与排除异常结果并排：异常票进原始结果、不进调整结果，且旧快照不被修改', () => {
  let rec = recordWithActivity();
  // 真实：2 票 B；协同：5 票 A
  rec = vote(rec, { vote_id: 'real-1', voter_account: 'r1', option: 'B' });
  rec = vote(rec, { vote_id: 'real-2', voter_account: 'r2', option: 'B', submitted_at: '2026-09-19T20:06:00+08:00' });
  for (let i = 0; i < 5; i += 1) {
    rec = vote(rec, { vote_id: `b-${i}`, voter_account: `g${i}`, option: 'A', submitted_at: `2026-09-19T20:3${i}:00+08:00` });
  }
  rec = flagAnomaly(rec, {
    activity_id: AID,
    flag_id: 'f1',
    kind: 'coordinated',
    evidence: '同批次账号 5 票在数十秒内投出，话术一致',
    flagged_at: '2026-09-20T09:00:00+08:00',
    resolution: 'excluded',
    resolution_reason: '三类证据印证',
    affected_refs: Array.from({ length: 5 }, (_, i) => `vote:b-${i}`),
  });
  rec = computeTallySnapshot(rec, { activity_id: AID, snapshot_id: 'raw', computed_at: '2026-09-19T22:05:00+08:00', kind: 'raw' });
  rec = computeTallySnapshot(rec, { activity_id: AID, snapshot_id: 'adj', computed_at: '2026-09-20T10:00:00+08:00', kind: 'adjusted', excluded_flag_ids: ['f1'], supersedes_snapshot: 'raw' });

  const a = () => rec.activities[0];
  assert.deepEqual(a().tally_snapshots.find((s) => s.snapshot_id === 'raw').ranking, ['A', 'B']);
  // A 全部为协同票被排除后，调整结果只剩 B（零票选项不出现在排名中）
  assert.deepEqual(a().tally_snapshots.find((s) => s.snapshot_id === 'adj').ranking, ['B']);

  const diff = diffSnapshots(a(), 'raw', 'adj');
  assert.equal(diff.winner_changed, true);
  assert.ok(diff.excluded_between.includes('b-0'));
  assert.equal(diff.per_option.A.delta, -5);
  assert.equal(diff.left.total_weighted - diff.right.total_weighted, 5);

  // 两份快照都还在：重算只追加，不覆盖原始结果
  assert.equal(a().tally_snapshots.length, 2);
  assert.deepEqual(a().tally_snapshots.find((s) => s.snapshot_id === 'raw').excluded_vote_ids, []);
});

test('调整快照只能引用已判定排除的标记', () => {
  let rec = recordWithActivity();
  rec = vote(rec, { vote_id: 'v1', option: 'A' });
  rec = flagAnomaly(rec, {
    activity_id: AID,
    flag_id: 'fq',
    kind: 'brigade',
    evidence: '待核实',
    flagged_at: '2026-09-20T09:00:00+08:00',
    resolution: 'quarantined',
    resolution_reason: '证据不足，先隔离复核',
  });
  assert.throws(
    () => computeTallySnapshot(rec, { activity_id: AID, snapshot_id: 'adj', computed_at: '2026-09-20T10:00:00+08:00', kind: 'adjusted', excluded_flag_ids: ['fq'] }),
    /已判定排除/,
  );
});

test('排除评论必须给依据；意见指纹忽略标点空白差异', () => {
  assert.equal(makeFingerprint('希望保留林晚支线！她和母亲的线，很打动人。'), makeFingerprint('希望保留林晚支线 她和母亲的线很打动人'));
  let rec = recordWithActivity();
  rec = addCommentThread(rec, { activity_id: AID, thread_id: 't1', topic: '支线' });
  assert.throws(
    () => addComment(rec, { activity_id: AID, thread_id: 't1', comment_id: 'c1', author_account: 'u1', text: 'x', posted_at: '2026-09-19T20:30:00+08:00', status: 'excluded' }),
    /exclusion_basis/,
  );
});

test('迟到评论默认不计入主题，显式纳入时也只影响主题归纳、不影响票', () => {
  let rec = recordWithActivity();
  rec = addCommentThread(rec, { activity_id: AID, thread_id: 't1', topic: '支线' });
  rec = addComment(rec, { activity_id: AID, thread_id: 't1', comment_id: 'c1', author_account: 'u1', text: '保留林晚支线', posted_at: '2026-09-19T20:30:00+08:00' });
  rec = addLateArrival(rec, {
    activity_id: AID,
    late_id: 'l1',
    kind: 'comment',
    payload: { author_account: 'u2', text: '保留林晚支线！' },
    observed_at: '2026-09-19T22:30:00+08:00',
    disposition: 'accepted_for_themes_only',
    basis: '迟到，仅用于主题',
  });
  const a = () => rec.activities[0];
  assert.equal(aggregateCommentThemes(a())[0].count, 1);
  const withLate = aggregateCommentThemes(a(), { includeLateAccepted: true })[0];
  assert.equal(withLate.count, 2);
  assert.deepEqual(withLate.sources.sort(), ['late_themes_only', 'on_time']);
});
