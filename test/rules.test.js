import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { loadRecord } from '../src/contracts.js';
import {
  assertRulesLockedBeforeStart,
  computeRulesHash,
  crossesNonDelegableBoundary,
  verifyRulesHash,
} from '../src/rules.js';

const here = dirname(fileURLToPath(import.meta.url));
const fixturePath = join(here, '..', 'fixtures', 'audience_feedback.json');

async function load() {
  return loadRecord(fixturePath);
}

test('互动规则在开始前已锁定，且资格/权重/截止/不可让渡边界齐全', async () => {
  const record = await load();
  const interaction = record.interactions[0];
  assert.equal(assertRulesLockedBeforeStart(interaction), true);
  assert.ok(Date.parse(interaction.locked_at) < Date.parse(interaction.starts_at));
  assert.ok(interaction.eligibility.weight_classes.some((w) => w.class === 'guest' && w.weight === 0));
  assert.ok(interaction.editorial_boundaries.non_delegable.length >= 1);
  assert.equal(interaction.editorial_boundaries.heat_is_not_a_command, true);
});

test('规则指纹与样例中存证一致，事后改动任何规则字段都会使校验失败', async () => {
  const record = await load();
  const interaction = record.interactions[0];
  assert.equal(computeRulesHash(interaction), interaction.rules_hash);
  assert.equal(verifyRulesHash(interaction, interaction.rules_hash), true);

  const tampered = { ...interaction, closes_at: '2026-09-18T22:00:00+08:00' };
  assert.notEqual(computeRulesHash(tampered), interaction.rules_hash);
  assert.throws(() => verifyRulesHash(tampered, interaction.rules_hash), /规则指纹不一致/);
});

test('锁定时间晚于开始时间的互动被拒绝', async () => {
  const record = await load();
  const bad = {
    ...record.interactions[0],
    interaction_id: 'poll-late-lock',
    locked_at: '2026-09-18T20:30:00+08:00',
  };
  assert.throws(() => assertRulesLockedBeforeStart(bad), /规则锁定晚于开始时间/);
});

test('缺少不可让渡边界声明的互动被拒绝', async () => {
  const record = await load();
  const bad = {
    ...record.interactions[0],
    interaction_id: 'poll-no-boundary',
    editorial_boundaries: { non_delegable: [], heat_is_not_a_command: true },
  };
  assert.throws(() => assertRulesLockedBeforeStart(bad), /未声明编辑不可让渡边界/);
});

test('热度不能命令创作：越过不可让渡边界的动作被识别', async () => {
  const record = await load();
  const interaction = record.interactions[0];
  const action = { boundary_key: '主线人物的生死与世界观结局', description: '让已死亡角色复活' };
  assert.equal(crossesNonDelegableBoundary(interaction, action), true);
  assert.equal(crossesNonDelegableBoundary(interaction, { description: '调整支线篇幅' }), false);
});
