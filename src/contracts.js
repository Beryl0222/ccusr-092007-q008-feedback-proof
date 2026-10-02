import { readFile } from 'node:fs/promises';

export const SUPPORTED_SCHEMA_VERSIONS = new Set([1, 2]);

function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value;
  for (const key of Object.keys(value)) deepFreeze(value[key]);
  return Object.freeze(value);
}

/**
 * 读取反馈凭证记录。
 * v1 仅含记录标识；v2 追加业务结构，既有字段（record_id/domain/occurred_at/revision/source）含义不变。
 * 记录整体递归冻结：业务模块只能追加新对象（新计票运行、新承诺状态等），不得原地改写历史。
 */
export async function loadRecord(path) {
  const payload = JSON.parse(await readFile(path, 'utf8'));
  if (!Number.isInteger(payload.schema_version) || !payload.record_id) {
    throw new Error('数据合同缺少必要标识');
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.has(payload.schema_version)) {
    throw new Error(`不支持的 schema_version: ${payload.schema_version}`);
  }
  return deepFreeze(payload);
}

/** 以结构化数据构造记录（测试与迁移用），同样递归冻结。 */
export function recordFromObject(payload) {
  if (!Number.isInteger(payload.schema_version) || !payload.record_id) {
    throw new Error('数据合同缺少必要标识');
  }
  if (!SUPPORTED_SCHEMA_VERSIONS.has(payload.schema_version)) {
    throw new Error(`不支持的 schema_version: ${payload.schema_version}`);
  }
  return deepFreeze(structuredClone(payload));
}
