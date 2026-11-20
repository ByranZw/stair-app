import { showToast } from './feedback'
const prefix = 'stair:form-draft:v1:'
const consumed = new Set<string>()
/** 草稿仅存本机独立命名空间，不进入账本，不触发交易或策略计算。 */
export function saveFormDraft(key: string, value: unknown): void {
  uni.setStorageSync(prefix + key, { schema: 1, value: JSON.parse(JSON.stringify(value)) })
  consumed.delete(key)
}
/** 只读取本版本草稿；恢复输入不代表已经通过账本校验或用户再次确认。 */
export function readFormDraft<T>(key: string): T | undefined {
  if (consumed.has(key)) return undefined
  const draft = uni.getStorageSync(prefix + key)
  return draft?.schema === 1 ? ((draft.value || undefined) as T) : undefined
}
/** 明确保存成功或取消预检后移除对应草稿，其他操作的输入互不影响。 */
export function clearFormDraft(key: string): void {
  consumed.add(key)
  try {
    uni.removeStorageSync(prefix + key)
  } catch {
    try {
      uni.setStorageSync(prefix + key, { schema: 1, value: null })
    } catch {
      showToast('操作已完成，但旧草稿清理失败，请勿重复提交')
    }
  }
}
