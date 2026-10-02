import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecord } from '../src/contracts.js';
import {
  clusterOfEntry,
  proposeSettlement,
  validateClusters,
  validateSettlements,
} from '../src/rewards.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'audience_feedback.json');

async function load() {
  return loadRecord(fixturePath);
}

test('意见聚类有效，跨入口条目归并到同一意见', async () => {
  const record = await load();
  assert.equal(validateClusters(record), true);
  const byTicket = clusterOfEntry(record, 'ticket:tk-001');
  const byComment = clusterOfEntry(record, 'comment:cm-001');
  assert.equal(byTicket.cluster_id, 'oc-001');
  assert.equal(byComment.cluster_id, 'oc-001');
  // 弹幕、评论、工单三个入口确实聚在同一条意见上
  const vias = new Set(byTicket.entries.map((e) => e.via));
  assert.ok(vias.has('support_ticket'));
  assert.ok(vias.has('live_chat'));
});

test('样例结算合规：同一意见只支付一次，重复申请被拒绝并留依据', async () => {
  const record = await load();
  assert.equal(validateSettlements(record), true);
  const [paid, denied] = record.reward_settlements;
  assert.equal(paid.status, 'paid');
  assert.equal(denied.status, 'denied_duplicate');
  assert.equal(paid.cluster_id, denied.cluster_id);
  assert.match(denied.basis, /rs-001/);
  assert.equal(denied.amount, 0);
});

test('尝试为已计酬意见的另一入口再次申请，只能得到 denied_duplicate', async () => {
  const record = await load();
  const proposal = proposeSettlement(record, {
    settlement_id: 'rs-new',
    entry_ref: 'ticket:tk-001',
    payee_identity_id: 'id-007',
    amount: 50,
    currency: 'CNY',
    at: '2026-09-21T10:00:00+08:00',
  });
  assert.equal(proposal.status, 'denied_duplicate');
  assert.equal(proposal.amount, 0);
});

test('首次申请的新意见进入 pending，尚未支付', async () => {
  const record = await load();
  const proposal = proposeSettlement(record, {
    settlement_id: 'rs-new2',
    entry_ref: 'comment:cm-005',
    payee_identity_id: 'id-005',
    amount: 30,
    currency: 'CNY',
    at: '2026-09-21T10:00:00+08:00',
  });
  assert.equal(proposal.status, 'pending');
  assert.equal(proposal.cluster_id, 'oc-003');
});

test('同一聚类出现两条 paid 记录会被拒绝', async () => {
  const record = await load();
  const mutated = structuredClone(record);
  mutated.reward_settlements.push({
    settlement_id: 'rs-dup-paid',
    period: '2026-09',
    cluster_id: 'oc-001',
    payee_identity_id: 'id-004',
    amount: 50,
    currency: 'CNY',
    entries_merged: ['comment:cm-002'],
    status: 'paid',
    paid_at: '2026-09-21T10:00:00+08:00',
    basis: '重复支付测试',
  });
  assert.throws(() => validateSettlements(mutated), /被重复计酬/);
});

test('结算归并了不属于该聚类的条目会被拒绝', async () => {
  const record = await load();
  const mutated = structuredClone(record);
  mutated.reward_settlements[0].entries_merged.push('comment:cm-005');
  assert.throws(() => validateSettlements(mutated), /不属于聚类/);
});
