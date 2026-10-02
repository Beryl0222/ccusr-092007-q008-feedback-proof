/**
 * 溯源模块。
 * 编辑应能：
 * 1) 并排查看原始结果与排除异常后的差异；
 * 2) 追溯某个内容变化实际依据的是哪一次（哪个规则版本的）计票运行；
 * 3) 看清热度不是创作命令：内容变化必须挂有人工作出的编辑决定与创作者回应。
 */

function byId(items, key) {
  return new Map((items ?? []).map((item) => [item[key], item]));
}

/** 并排对比某互动某次运行的原始口径与调整口径。 */
export function compareRun(record, runId) {
  const run = (record.tally_runs ?? []).find((r) => r.run_id === runId);
  if (!run) throw new Error(`计票运行不存在: ${runId}`);

  const raw = run.raw.ballots;
  const adjusted = run.adjusted?.ballots ?? null;
  const optionIds = new Set([...Object.keys(raw), ...(adjusted ? Object.keys(adjusted) : [])]);

  const per_option = [...optionIds].map((optionId) => {
    const row = { option_id: optionId, raw: raw[optionId] ?? 0, adjusted: null, removed: null };
    if (adjusted) {
      row.adjusted = adjusted[optionId] ?? 0;
      row.removed = row.raw - row.adjusted;
    }
    return row;
  });

  return {
    interaction_id: run.interaction_id,
    run_id: run.run_id,
    rule_version: run.rule_version,
    status: run.status,
    kind: run.kind,
    adjustments_applied: run.adjustments_applied,
    late_separately_recorded: run.adjusted?.late_separately_recorded ?? [],
    raw,
    adjusted,
    per_option,
    verdict:
      adjusted && JSON.stringify(adjusted) === JSON.stringify(raw)
        ? '两口径一致'
        : '两口径存在差异，差异全部可在调整台账中逐条核对依据',
  };
}

/**
 * 追溯一个内容变化的完整依据链：
 * 内容变化 → 计票运行（含规则版本与指纹）→ 调整台账 → 创作者回应 → 编辑决定。
 */
export function traceChange(record, changeId) {
  const change = (record.content_changes ?? []).find((c) => c.change_id === changeId);
  if (!change) throw new Error(`内容变化不存在: ${changeId}`);

  const runs = new Map(byId(record.tally_runs, 'run_id'));
  const responses = byId(record.creator_responses, 'response_id');
  const decisions = byId(record.editorial_decisions, 'decision_id');
  const adjustments = byId(record.adjustments_ledger, 'adjustment_id');

  const basisRuns = (change.basis_run_ids ?? []).map((runId) => {
    const run = runs.get(runId);
    if (!run) throw new Error(`变化 ${changeId} 引用了不存在的计票运行: ${runId}`);
    return {
      run_id: run.run_id,
      status: run.status,
      kind: run.kind,
      rule_version: run.rule_version,
      rules_hash: run.rules_hash,
      computed_at: run.computed_at,
      superseded_by_later: (record.tally_runs ?? []).some((r) => r.supersedes === runId),
      raw: run.raw.ballots,
      adjusted: run.adjusted?.ballots ?? null,
      adjustments: run.adjustments_applied.map((id) => adjustments.get(id)),
    };
  });

  const decision = change.editorial_decision_ref ? decisions.get(change.editorial_decision_ref) : null;
  const response = change.creator_response_id ? responses.get(change.creator_response_id) : null;

  return {
    change_id: change.change_id,
    description: change.description,
    from_version_id: change.from_version_id,
    to_version_id: change.to_version_id,
    basis_runs: basisRuns,
    editorial_decision: decision
      ? {
          decision_id: decision.decision_id,
          decided_by: decision.decided_by,
          decided_at: decision.decided_at,
          summary: decision.summary,
          superseded_by: decision.superseded_by ?? null,
        }
      : null,
    creator_response: response
      ? {
          response_id: response.response_id,
          decision: response.decision,
          rationale: response.rationale,
          visibility: response.visibility,
        }
      : null,
  };
}

/**
 * 校验内容变化的依据合规性：
 * - 必须挂有人工作出的编辑决定（热度本身不是命令）；
 * - 至少依据一次存在的计票运行；
 * - 不允许仅依据已被取代的 provisional 运行而没有后续纠正记录。
 */
export function assertChangeIsEditoriallyGrounded(record, changeId) {
  const trace = traceChange(record, changeId);
  if (!trace.editorial_decision) {
    throw new Error(`内容变化 ${changeId} 缺少人工编辑决定，热度不得自动成为创作命令`);
  }
  if (trace.basis_runs.length === 0) {
    throw new Error(`内容变化 ${changeId} 没有任何计票运行作为依据`);
  }
  const onlySupersededProvisional =
    trace.basis_runs.length > 0
    && trace.basis_runs.every((r) => r.status === 'provisional' && r.superseded_by_later)
    && trace.editorial_decision.superseded_by === null;
  if (onlySupersededProvisional) {
    throw new Error(
      `内容变化 ${changeId} 仅依据已被正式重算取代的临时结果，且编辑决定未被纠正标记`,
    );
  }
  return true;
}

/** 列出某次计票运行实际支撑的内容变化（反向追溯）。 */
export function changesBasedOnRun(record, runId) {
  return (record.content_changes ?? [])
    .filter((c) => (c.basis_run_ids ?? []).includes(runId))
    .map((c) => c.change_id);
}
