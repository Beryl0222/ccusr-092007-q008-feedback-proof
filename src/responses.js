/**
 * 创作者回应模块：
 * - 创作者对反馈只能作出 adopted / partially_adopted / rejected 三种决定，且必须给理由；
 * - private_draft 只对 access_list 内的获准编辑开放；
 * - 对订阅者正式作出的承诺进入 subscriber_promises，状态流转追加留痕、可核验。
 */

export const DECISIONS = Object.freeze({
  ADOPTED: 'adopted',
  PARTIALLY_ADOPTED: 'partially_adopted',
  REJECTED: 'rejected',
});

export const VISIBILITY = Object.freeze({
  PRIVATE_DRAFT: 'private_draft',
  EDITORIAL: 'editorial',
  SUBSCRIBER_PUBLIC: 'subscriber_public',
});

function byId(items, key) {
  return new Map((items ?? []).map((item) => [item[key], item]));
}

/** 校验全部创作者回应：决定值合法、理由非空；凡引用计票运行的，运行必须存在。 */
export function validateResponses(record) {
  const runs = new Set((record.tally_runs ?? []).map((r) => r.run_id));
  for (const response of record.creator_responses ?? []) {
    if (!Object.values(DECISIONS).includes(response.decision)) {
      throw new Error(`回应 ${response.response_id} 决定值非法: ${response.decision}`);
    }
    if (!response.rationale || !response.rationale.trim()) {
      throw new Error(`回应 ${response.response_id} 必须记录理由`);
    }
    if (!response.decided_by || !response.decided_at) {
      throw new Error(`回应 ${response.response_id} 缺少决定人与决定时间`);
    }
    if (response.tally_run_id && !runs.has(response.tally_run_id)) {
      throw new Error(`回应 ${response.response_id} 引用了不存在的计票运行: ${response.tally_run_id}`);
    }
    if (response.visibility === VISIBILITY.PRIVATE_DRAFT) {
      if (!Array.isArray(response.access_list) || response.access_list.length === 0) {
        throw new Error(`私人草稿 ${response.response_id} 必须声明获准访问名单`);
      }
    }
  }
  return true;
}

/**
 * 访问控制：某查看者能否读取某条回应。
 * subscriber_public：订阅者可见；editorial：仅编辑/创作者；private_draft：仅 access_list 内人员。
 * 这里只做权限判断，回应的结构合法性由 validateResponses 在整记录层面保证。
 */
export function canReadResponse(response, viewer) {
  switch (response.visibility) {
    case VISIBILITY.SUBSCRIBER_PUBLIC:
      return viewer.is_subscriber === true || viewer.role === 'editor' || viewer.role === 'creator';
    case VISIBILITY.EDITORIAL:
      return viewer.role === 'editor' || viewer.role === 'creator' || viewer.actor_id === response.decided_by;
    case VISIBILITY.PRIVATE_DRAFT:
      return (response.access_list ?? []).includes(viewer.actor_id);
    default:
      throw new Error(`回应 ${response.response_id} 可见性非法: ${response.visibility}`);
  }
}

/** 访问控制：私人草稿版本只对版本 access_list 内的获准编辑开放。 */
export function canReadContentVersion(version, viewer) {
  if (version.state !== 'private_draft') return true;
  return (version.access_list ?? []).includes(viewer.actor_id);
}

/** 列出某查看者可见的回应（草稿越权时不泄露内容，只给拒绝结果）。 */
export function visibleResponses(record, viewer) {
  validateResponses(record);
  return (record.creator_responses ?? []).filter((r) => canReadResponse(r, viewer));
}

// ---- 订阅者承诺 ----

export const PROMISE_STATUSES = Object.freeze({
  OPEN: 'open',
  IN_PROGRESS: 'in_progress',
  FULFILLED: 'fulfilled',
  WITHDRAWN: 'withdrawn',
  BROKEN: 'broken',
});

/** 允许的状态迁移；任何迁移都必须留 history 记录。 */
const ALLOWED_TRANSITIONS = {
  open: new Set(['in_progress', 'fulfilled', 'withdrawn', 'broken']),
  in_progress: new Set(['fulfilled', 'withdrawn', 'broken']),
  fulfilled: new Set(),
  withdrawn: new Set(),
  broken: new Set(['fulfilled']),
};

/** 校验承诺：历史迁移合法、终态必须有可核验证据、当前状态与历史末态一致。 */
export function validatePromise(promise) {
  if (!promise.promise_id || !promise.made_by || !promise.made_at || !promise.scope) {
    throw new Error(`承诺缺少必要登记字段: ${promise.promise_id ?? '?'}`);
  }
  if (!Array.isArray(promise.history) || promise.history.length === 0) {
    throw new Error(`承诺 ${promise.promise_id} 没有状态历史`);
  }
  let current = null;
  for (const entry of promise.history) {
    if (!entry.at || !entry.by || entry.to_status === undefined) {
      throw new Error(`承诺 ${promise.promise_id} 历史条目缺少时间/操作人/目标状态`);
    }
    if (current !== null && entry.to_status === current) {
      // 状态不变的核验备注（如编辑部核验）允许留痕，但必须写明备注，不能空刷历史。
      if (!entry.note || !entry.note.trim()) {
        throw new Error(`承诺 ${promise.promise_id} 状态未变化的历史条目必须写明核验备注`);
      }
    } else if (current !== null && !ALLOWED_TRANSITIONS[current]?.has(entry.to_status)) {
      throw new Error(`承诺 ${promise.promise_id} 非法状态迁移: ${current} -> ${entry.to_status}`);
    }
    current = entry.to_status;
  }
  if (current !== promise.status) {
    throw new Error(`承诺 ${promise.promise_id} 当前状态与历史末态不一致`);
  }
  if (promise.status === PROMISE_STATUSES.FULFILLED) {
    if (!promise.verification?.evidence_content_id && !promise.verification?.evidence_hash) {
      throw new Error(`承诺 ${promise.promise_id} 标记已履行但缺少可核验证据`);
    }
  }
  return true;
}

/** 订阅者可核验的承诺状态视图。 */
export function promiseStatusForSubscriber(promise) {
  validatePromise(promise);
  return {
    promise_id: promise.promise_id,
    statement: promise.statement,
    status: promise.status,
    made_at: promise.made_at,
    due_at: promise.due_at ?? null,
    verifiable:
      promise.status === PROMISE_STATUSES.FULFILLED
        ? { kind: promise.verification.kind, evidence: promise.verification.evidence_content_id }
        : { kind: promise.verification?.kind ?? null, evidence: null },
  };
}

/** 追加一条承诺状态迁移，返回新承诺对象（原对象不变）。 */
export function transitionPromise(promise, toStatus, entry) {
  validatePromise(promise);
  const allowed = ALLOWED_TRANSITIONS[promise.status] ?? new Set();
  if (!allowed.has(toStatus)) {
    throw new Error(`承诺 ${promise.promise_id} 非法状态迁移: ${promise.status} -> ${toStatus}`);
  }
  const next = structuredClone(promise);
  next.status = toStatus;
  next.history.push({
    at: entry.at,
    from_status: promise.status,
    to_status: toStatus,
    by: entry.by,
    note: entry.note ?? '',
  });
  if (toStatus === PROMISE_STATUSES.FULFILLED) {
    if (!entry.evidence_content_id && !entry.evidence_hash) {
      throw new Error('承诺履行必须同时登记可核验证据');
    }
    next.verification = {
      ...next.verification,
      evidence_content_id: entry.evidence_content_id ?? next.verification?.evidence_content_id ?? null,
      evidence_hash: entry.evidence_hash ?? next.verification?.evidence_hash ?? null,
    };
  }
  return Object.freeze(next);
}
