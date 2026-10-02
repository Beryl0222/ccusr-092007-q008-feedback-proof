/**
 * 贡献奖励结算模块。
 * 同一意见即使通过直播弹幕、网文评论、工单等多个入口出现，也只能计酬一次：
 * 计酬单位是意见聚类（opinion_clusters），不是入口条目。
 * 重复申请必须留拒绝依据；已支付与已拒绝的结算都追加留痕，不允许就同一聚类二次支付。
 */

export const SETTLEMENT_STATUS = Object.freeze({
  PAID: 'paid',
  DENIED_DUPLICATE: 'denied_duplicate',
  PENDING: 'pending',
});

function byId(items, key) {
  return new Map((items ?? []).map((item) => [item[key], item]));
}

/** 校验意见聚类：指纹唯一、引用条目存在、入口列表非空。 */
export function validateClusters(record) {
  const fingerprints = new Set();
  for (const cluster of record.opinion_clusters ?? []) {
    if (fingerprints.has(cluster.fingerprint)) {
      throw new Error(`意见指纹重复，聚类可能被重复拆分: ${cluster.fingerprint}`);
    }
    fingerprints.add(cluster.fingerprint);
    if (!Array.isArray(cluster.entries) || cluster.entries.length === 0) {
      throw new Error(`意见聚类 ${cluster.cluster_id} 没有任何入口条目`);
    }
    if (!cluster.entries.some((e) => e.entry_ref === cluster.first_verifiable_entry)) {
      throw new Error(`聚类 ${cluster.cluster_id} 的最早可核验条目不在入口列表中`);
    }
  }
  return true;
}

/** 把任意入口条目（comment:cm-1 / ticket:tk-1 / vote:v-1）归并到意见聚类。 */
export function clusterOfEntry(record, entryRef) {
  return (record.opinion_clusters ?? []).find((c) =>
    c.entries.some((e) => e.entry_ref === entryRef),
  );
}

/**
 * 校验奖励结算台账：
 * - 同一意见聚类至多一条 paid；
 * - denied_duplicate 必须指向已有（或同批先于它的）结算；
 * - 结算条目必须能归并到一个意见聚类；
 * - 收款人必须是可识别身份。
 */
export function validateSettlements(record) {
  validateClusters(record);
  const paidClusters = new Map();
  const knownSettlements = new Set();

  for (const settlement of record.reward_settlements ?? []) {
    if (knownSettlements.has(settlement.settlement_id)) {
      throw new Error(`结算记录重复: ${settlement.settlement_id}`);
    }
    knownSettlements.add(settlement.settlement_id);

    if (!settlement.cluster_id) {
      throw new Error(`结算 ${settlement.settlement_id} 未绑定意见聚类`);
    }
    const cluster = (record.opinion_clusters ?? []).find((c) => c.cluster_id === settlement.cluster_id);
    if (!cluster) throw new Error(`结算 ${settlement.settlement_id} 绑定了不存在的聚类`);

    if (settlement.status === SETTLEMENT_STATUS.PAID) {
      if (paidClusters.has(settlement.cluster_id)) {
        throw new Error(
          `同一意见 ${settlement.cluster_id} 被重复计酬: ${paidClusters.get(settlement.cluster_id)} 与 ${settlement.settlement_id}`,
        );
      }
      if (!Number.isFinite(settlement.amount) || settlement.amount <= 0) {
        throw new Error(`结算 ${settlement.settlement_id} 金额非法`);
      }
      if (!settlement.payee_identity_id || !byId(record.identities, 'identity_id').has(settlement.payee_identity_id)) {
        throw new Error(`结算 ${settlement.settlement_id} 收款人身份无法识别`);
      }
      // 结算登记的归并条目必须确实属于该聚类（跨入口归并的证据）。
      for (const ref of settlement.entries_merged ?? []) {
        if (!cluster.entries.some((e) => e.entry_ref === ref)) {
          throw new Error(`结算 ${settlement.settlement_id} 归并了不属于聚类 ${cluster.cluster_id} 的条目: ${ref}`);
        }
      }
      paidClusters.set(settlement.cluster_id, settlement.settlement_id);
    }

    if (settlement.status === SETTLEMENT_STATUS.DENIED_DUPLICATE) {
      if (!paidClusters.has(settlement.cluster_id)) {
        throw new Error(`结算 ${settlement.settlement_id} 标记重复拒绝，但该意见尚无已支付结算`);
      }
      if (!settlement.basis || !settlement.basis.includes(paidClusters.get(settlement.cluster_id))) {
        throw new Error(`重复拒绝 ${settlement.settlement_id} 未引用首次计酬依据`);
      }
    }
  }
  return true;
}

/**
 * 提议一笔结算：对某个入口条目申请奖励时，先归并到意见聚类，
 * 若该聚类已支付，只能生成 denied_duplicate，绝不二次支付。
 */
export function proposeSettlement(record, { settlement_id, entry_ref, payee_identity_id, amount, currency, at }) {
  const cluster = clusterOfEntry(record, entry_ref);
  if (!cluster) throw new Error(`条目 ${entry_ref} 无法归并到任何意见聚类`);

  const priorPaid = (record.reward_settlements ?? []).find(
    (s) => s.cluster_id === cluster.cluster_id && s.status === SETTLEMENT_STATUS.PAID,
  );

  if (priorPaid) {
    return Object.freeze({
      settlement_id,
      period: at.slice(0, 7),
      cluster_id: cluster.cluster_id,
      payee_identity_id,
      amount: 0,
      currency: currency ?? priorPaid.currency,
      entries_merged: [entry_ref],
      status: SETTLEMENT_STATUS.DENIED_DUPLICATE,
      paid_at: null,
      basis: `与 ${priorPaid.settlement_id} 属同一意见聚类 ${cluster.cluster_id}，同一意见跨入口只计酬一次`,
    });
  }

  return Object.freeze({
    settlement_id,
    period: at.slice(0, 7),
    cluster_id: cluster.cluster_id,
    payee_identity_id,
    amount,
    currency,
    entries_merged: [entry_ref],
    status: SETTLEMENT_STATUS.PENDING,
    paid_at: null,
    basis: '待审核支付；支付后该聚类其余入口申请一律按重复拒绝',
  });
}
