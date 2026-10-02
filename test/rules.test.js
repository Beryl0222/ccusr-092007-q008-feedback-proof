import test from 'node:test';
import assert from 'node:assert/strict';
import { migrate, createActivity, freezeRules, validateV2 } from '../src/contracts.js';
import { emptyRecord, baseRules } from './helpers.js';

test('v1 样例迁移到 v2：标识与时间含义保持，空容器不编造业务数据', () => {
  const v2 = migrate({
    schema_version: 1,
    record_id: 'sample-008',
    domain: 'feedback_proof',
    occurred_at: '2026-09-20T09:00:00+08:00',
    revision: 1,
    source: '业务样例',
  });
  assert.equal(v2.schema_version, 2);
  assert.equal(v2.record_id, 'sample-008');
  assert.equal(v2.domain, 'feedback_proof');
  assert.equal(v2.revision, 1); // 迁移不增 revision
  assert.deepEqual(v2.activities, []);
  assert.deepEqual(v2.identity_merges, []);
});

test('规则必须在开始前冻结，开始后冻结被拒绝', () => {
  const a = createActivity({
    activity_id: 'a',
    title: 't',
    scheduled_start_at: '2026-09-19T20:00:00+08:00',
    deadline_at: '2026-09-19T22:00:00+08:00',
    rules: baseRules,
  });
  assert.throws(() => freezeRules(a, '2026-09-19T20:30:00+08:00'), /开始前冻结/);
  const frozen = freezeRules(a, '2026-09-19T19:59:59+08:00');
  assert.equal(frozen.rules_status, 'frozen');
  // 冻结后再次修改被拒绝
  assert.throws(() => freezeRules(frozen, '2026-09-19T19:00:00+08:00'), /已冻结/);
});

test('资格、权重、截止与不可让渡边界在快照中固定', () => {
  const a = freezeRules(
    createActivity({
      activity_id: 'a',
      title: 't',
      scheduled_start_at: '2026-09-19T20:00:00+08:00',
      deadline_at: '2026-09-19T22:00:00+08:00',
      rules: baseRules,
    }),
    '2026-09-18T12:00:00+08:00',
  );
  const r = a.rules_snapshot;
  assert.deepEqual(r.eligible_audience, ['paid_subscriber', 'single_ticket']);
  assert.equal(r.deadline_at, '2026-09-19T22:00:00+08:00');
  assert.equal(r.scheduled_start_at, '2026-09-19T20:00:00+08:00');
  assert.equal(r.default_weight, 1);
  assert.equal(r.weight_overrides.paid_subscriber, 2);
  assert.ok(r.editor_non_delegable.includes('续篇立项决定权'));
  assert.equal(r.can_audience_veto, false);
  assert.equal(r.heat_is_command, false);
});

test('合同把底线写死：观众否决权 / 热度即命令 均非法', () => {
  const bad = createActivity({
    activity_id: 'a',
    title: 't',
    scheduled_start_at: '2026-09-19T20:00:00+08:00',
    deadline_at: '2026-09-19T22:00:00+08:00',
    rules: { ...baseRules, can_audience_veto: true },
  });
  // createActivity 强制 false，但直接篡改快照后 validateV2 必须挡住
  const frozen = structuredClone(freezeRules(bad, '2026-09-18T12:00:00+08:00'));
  frozen.rules_snapshot.can_audience_veto = true;
  assert.throws(() => validateV2({ ...emptyRecord(), activities: [frozen] }), /否决权/);
});

test('冻结后篡改截止时间会被校验拒绝', () => {
  const a = freezeRules(
    createActivity({
      activity_id: 'a',
      title: 't',
      scheduled_start_at: '2026-09-19T20:00:00+08:00',
      deadline_at: '2026-09-19T22:00:00+08:00',
      rules: baseRules,
    }),
    '2026-09-18T12:00:00+08:00',
  );
  const tampered = structuredClone(a);
  tampered.deadline_at = '2026-09-19T23:00:00+08:00'; // 延后截止而快照未变
  assert.throws(() => validateV2({ ...emptyRecord(), activities: [tampered] }), /截止时间与活动/);
});

test('缺少资格或不可让渡边界不能创建活动', () => {
  assert.throws(
    () => createActivity({ activity_id: 'a', title: 't', scheduled_start_at: '2026-09-19T20:00:00+08:00', deadline_at: '2026-09-19T22:00:00+08:00', rules: { ...baseRules, eligible_audience: [] } }),
    /参与资格/,
  );
  assert.throws(
    () => createActivity({ activity_id: 'a', title: 't', scheduled_start_at: '2026-09-19T20:00:00+08:00', deadline_at: '2026-09-19T22:00:00+08:00', rules: { ...baseRules, editor_non_delegable: [] } }),
    /不可让渡/,
  );
});
