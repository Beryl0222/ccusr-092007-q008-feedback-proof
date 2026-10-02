import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addContentVersion,
  publishContentVersion,
  recordDecision,
  traceContentChange,
  createPledge,
  transitionPledge,
  publicPledgeStatus,
  addPrivateDraft,
  readPrivateDraft,
  settleReward,
  previewSettlements,
} from '../src/editorial.js';
import { addVote, computeTallySnapshot, addCommentThread, addComment, makeFingerprint } from '../src/feedback.js';
import { recordWithActivity } from './helpers.js';

const AID = 'act-1';

function withContent(rec) {
  rec = addContentVersion(rec, { version_id: 'cv1', kind: 'chapter', created_at: '2026-09-10T10:00:00+08:00' });
  rec = publishContentVersion(rec, { version_id: 'cv1', published_at: '2026-09-12T20:00:00+08:00' });
  rec = addContentVersion(rec, { version_id: 'cv2', kind: 'chapter', created_at: '2026-09-20T08:00:00+08:00', supersedes: 'cv1' });
  rec = publishContentVersion(rec, { version_id: 'cv2', published_at: '2026-09-20T12:00:00+08:00' });
  return rec;
}

function snapshot(rec, id, computed_at = '2026-09-19T22:05:00+08:00') {
  return computeTallySnapshot(rec, { activity_id: AID, snapshot_id: id, computed_at, kind: 'raw' });
}

test('已发布版本不可重复发布或修改；变化只能追加新版本', () => {
  let rec = withContent(recordWithActivity());
  assert.throws(() => publishContentVersion(rec, { version_id: 'cv1', published_at: '2026-09-30T00:00:00+08:00' }), /不可重复发布/);
  // 新版本追加被允许
  rec = addContentVersion(rec, { version_id: 'cv3', kind: 'chapter', created_at: '2026-09-21T08:00:00+08:00', supersedes: 'cv2' });
  assert.ok(rec.content_versions.some((c) => c.version_id === 'cv3'));
});

test('决定必须由人作出、带理由、钉住一个已存在快照；缺快照或缺理由被拒', () => {
  let rec = withContent(recordWithActivity());
  rec = addVote(rec, { activity_id: AID, vote_id: 'v1', voter_account: 'u1', segment: 'single_ticket', option: 'A', submitted_at: '2026-09-19T20:05:00+08:00' });
  rec = snapshot(rec, 's1');
  assert.throws(
    () => recordDecision(rec, { activity_id: AID, decision_id: 'dX', content_version_id: 'cv2', based_on_snapshot_id: 'nope', outcome: 'adopted', rationale: 'r', decided_by: 'z', decided_at: '2026-09-20T13:00:00+08:00' }),
    /已存在的计票快照/,
  );
  assert.throws(
    () => recordDecision(rec, { activity_id: AID, decision_id: 'dX', content_version_id: 'cv2', based_on_snapshot_id: 's1', outcome: 'adopted', rationale: '  ', decided_by: 'z', decided_at: '2026-09-20T13:00:00+08:00' }),
    /理由/,
  );
  rec = recordDecision(rec, { activity_id: AID, decision_id: 'd1', content_version_id: 'cv2', based_on_snapshot_id: 's1', outcome: 'partially_adopted', adopted_elements: ['留一个钩子'], rationale: '人工综合时长与反馈', decided_by: 'chief_zhao', decided_at: '2026-09-20T13:00:00+08:00' });
  // 同一内容版本不能再叠加第二条决定（不得改写历史）
  assert.throws(
    () => recordDecision(rec, { activity_id: AID, decision_id: 'd2', content_version_id: 'cv2', based_on_snapshot_id: 's1', outcome: 'rejected', rationale: '改主意', decided_by: 'z', decided_at: '2026-09-20T14:00:00+08:00' }),
    /已有决定/,
  );
});

test('部分采用必须列出采用要素', () => {
  let rec = withContent(recordWithActivity());
  rec = snapshot(rec, 's1');
  assert.throws(
    () => recordDecision(rec, { activity_id: AID, decision_id: 'd1', content_version_id: 'cv2', based_on_snapshot_id: 's1', outcome: 'partially_adopted', rationale: 'r', decided_by: 'z', decided_at: '2026-09-20T13:00:00+08:00' }),
    /采用要素/,
  );
});

test('可追溯内容变化实际依据的活动与计票版本（原始/调整）', () => {
  let rec = withContent(recordWithActivity());
  rec = addVote(rec, { activity_id: AID, vote_id: 'v1', voter_account: 'u1', segment: 'single_ticket', option: 'A', submitted_at: '2026-09-19T20:05:00+08:00' });
  rec = snapshot(rec, 's1');
  rec = recordDecision(rec, { activity_id: AID, decision_id: 'd1', content_version_id: 'cv2', based_on_snapshot_id: 's1', outcome: 'adopted', rationale: '依据原始结果并结合编辑判断', decided_by: 'chief_zhao', decided_at: '2026-09-20T13:00:00+08:00' });
  const trace = traceContentChange(rec, 'cv2');
  assert.equal(trace.basis.length, 1);
  assert.equal(trace.basis[0].based_on.snapshot_id, 's1');
  assert.equal(trace.basis[0].based_on.kind, 'raw');
  assert.equal(trace.basis[0].decided_by, 'chief_zhao');
});

test('承诺状态只能按时间追加；履行必须提供可核验材料；公开视图不含草稿', () => {
  let rec = withContent(recordWithActivity());
  rec = createPledge(rec, { activity_id: AID, pledge_id: 'p1', statement: '下周恢复支线', audience_scope: 'paid_subscriber', status: 'made', at: '2026-09-20T12:00:00+08:00', by: 'z' });
  assert.throws(
    () => transitionPledge(rec, { activity_id: AID, pledge_id: 'p1', status: 'fulfilled', at: '2026-09-21T12:00:00+08:00', by: 'z' }),
    /可核验材料/,
  );
  assert.throws(
    () => transitionPledge(rec, { activity_id: AID, pledge_id: 'p1', status: 'in_progress', at: '2026-09-19T12:00:00+08:00', by: 'z' }),
    /按时间追加/,
  );
  rec = transitionPledge(rec, { activity_id: AID, pledge_id: 'p1', status: 'fulfilled', at: '2026-09-21T12:00:00+08:00', by: 'z', verification: [{ type: 'url', url: 'https://example.test/ch8' }] });
  const view = publicPledgeStatus(rec, AID, 'p1');
  assert.equal(view.status, 'fulfilled');
  assert.equal(view.history.length, 2);
  assert.ok(!JSON.stringify(view).includes('draft_id'));
  assert.ok(!JSON.stringify(view).includes('内部内容'));
});

test('私人草稿只对获准编辑开放', () => {
  let rec = withContent(recordWithActivity());
  rec = addPrivateDraft(rec, { draft_id: 'dr1', owner: 'writer_lu', title: '续篇草稿', body: '内部内容', created_at: '2026-09-21T09:00:00+08:00', allowed_editors: ['chief_zhao'] });
  assert.equal(readPrivateDraft(rec, 'dr1', 'chief_zhao').body, '内部内容');
  assert.equal(readPrivateDraft(rec, 'dr1', 'writer_lu').body, '内部内容'); // owner 自动获准
  assert.throws(() => readPrivateDraft(rec, 'dr1', 'random_subscriber'), /无权访问/);
});

test('奖励：同一意见多入口只计酬一次；重复指纹不能再次 paid', () => {
  let rec = withContent(recordWithActivity());
  rec = addCommentThread(rec, { activity_id: AID, thread_id: 't1', topic: '支线' });
  const text = '希望保留林晚支线，她和母亲的线很打动人';
  rec = addComment(rec, { activity_id: AID, thread_id: 't1', comment_id: 'c1', author_account: 'u1', text, posted_at: '2026-09-19T20:30:00+08:00' });
  rec = addComment(rec, { activity_id: AID, thread_id: 't1', comment_id: 'c2', author_account: 'u2', text: '希望保留林晚支线！她和母亲的线，很打动人。', posted_at: '2026-09-19T20:40:00+08:00' });
  const fp = makeFingerprint(text);
  rec = settleReward(rec, { settlement_id: 'st1', opinion_fingerprint: fp, source_refs: ['comment:c1', 'comment:c2'], payee: 'u1', amount: 200, status: 'paid', paid_at: '2026-09-30T12:00:00+08:00' });
  // 全局再出现一笔相同指纹的 paid 直接违反合同
  assert.throws(
    () => settleReward(rec, { settlement_id: 'st2', opinion_fingerprint: fp, source_refs: ['external:weibo:999'], payee: 'u1', amount: 200, status: 'paid', paid_at: '2026-10-01T12:00:00+08:00' }),
    /重复计酬/,
  );
  // 预检：待结列表里同批/历史重复都应标为不可支付
  const preview = previewSettlements(rec, [
    { settlement_id: 'stA', opinion_fingerprint: fp, source_refs: ['x:1'] },
    { settlement_id: 'stB', opinion_fingerprint: 'new-one', source_refs: ['y:1'] },
    { settlement_id: 'stC', opinion_fingerprint: 'new-one', source_refs: ['y:2'] },
  ]);
  assert.equal(preview.find((p) => p.settlement_id === 'stA').payable, false);
  assert.equal(preview.find((p) => p.settlement_id === 'stA').duplicate_of_paid, 'st1');
  assert.equal(preview.find((p) => p.settlement_id === 'stB').payable, true);
  assert.equal(preview.find((p) => p.settlement_id === 'stC').payable, false);
  assert.equal(preview.find((p) => p.settlement_id === 'stC').merged_within_batch, 'stB');
});
