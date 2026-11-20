import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { utf8Bytes } from './encoding'
import type { Book } from './book'
import { projectBook } from './ledger'
import { appendPlanEvent, planSnapshot } from './plan-history'

export const MAX_BACKUP_BYTES = 10 * 1024 * 1024
/** 只备份权威账本；行情缓存不构成价格凭据，自选保留目标设备的独立列表。 */
export interface Backup {
  format: 'stair-book'
  schemaVersion: 1
  createdAt: string
  book: Book
  checksum: { algorithm: 'SHA-256'; value: string }
}
/** 对象键顺序稳定，数组维持原始顺序，便于跨设备核对同一份账本。 */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']'
  if (value && typeof value === 'object') {
    return (
      '{' +
      Object.keys(value)
        .sort()
        .map(
          (key) =>
            JSON.stringify(key) + ':' + canonicalJson((value as Record<string, unknown>)[key]),
        )
        .join(',') +
      '}'
    )
  }
  return JSON.stringify(value)
}
/** 校验包含版本、导出时间和账本，防止只校验交易而忽略元数据损坏。 */
function checksum(content: Omit<Backup, 'checksum'>): string {
  return bytesToHex(sha256(utf8Bytes(canonicalJson(content))))
}
/** 文件体积在读取与解析边界均限制，避免大文件阻塞移动端界面。 */
export function assertBackupSize(text: string): void {
  if (text.length > MAX_BACKUP_BYTES || utf8Bytes(text).length > MAX_BACKUP_BYTES)
    throw new Error('备份文件超过10MB，请选择拾阶导出的账本文件')
}
/** 导出基于已提交账本的独立快照，不携带持仓投影或外部报价。 */
export function createBackup(book: Book, createdAt = new Date().toISOString()): string {
  const snapshot: Book = JSON.parse(JSON.stringify(book))
  projectBook(snapshot)
  const content: Omit<Backup, 'checksum'> = {
    format: 'stair-book',
    schemaVersion: 1,
    createdAt,
    book: snapshot,
  }
  const data: Backup = { ...content, checksum: { algorithm: 'SHA-256', value: checksum(content) } }
  const text = JSON.stringify(data, null, 2)
  assertBackupSize(text)
  return text
}
/** 先校验封装和哈希，再重放资金成本；预检不访问数据库、不修改当前账本。 */
export function readBackup(text: string): Backup {
  assertBackupSize(text)
  let raw: unknown
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ''))
  } catch {
    throw new Error('文件不是有效的JSON备份，当前账本未改变')
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('不是拾阶账本备份')
  const data = raw as Backup
  if (data.format !== 'stair-book') throw new Error('不是拾阶账本备份，请使用本应用导出的文件')
  if (data.schemaVersion !== 1 || data.book?.schema !== 1)
    throw new Error('该备份版本暂不支持，请保留文件并升级应用')
  if (
    typeof data.createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T/.test(data.createdAt) ||
    Number.isNaN(Date.parse(data.createdAt))
  )
    throw new Error('备份导出时间无效')
  if (data.checksum?.algorithm !== 'SHA-256' || !/^[a-f0-9]{64}$/.test(data.checksum.value))
    throw new Error('备份缺少有效完整性校验')
  const content: Omit<Backup, 'checksum'> = {
    format: data.format,
    schemaVersion: data.schemaVersion,
    createdAt: data.createdAt,
    book: data.book,
  }
  if (checksum(content) !== data.checksum.value)
    throw new Error('备份校验不通过，文件可能不完整或被改动；当前账本未改变')
  try {
    projectBook(data.book)
  } catch (error) {
    throw new Error(`备份账本无法恢复：${error instanceof Error ? error.message : '数据格式有误'}`)
  }
  return data
}
/** 金额和成交保持原值；跨设备恢复不能沿用旧提醒或把采样高点当最新行情。 */
export function prepareRestoredBook(book: Book): Book {
  const next: Book = JSON.parse(JSON.stringify(book))
  for (const plan of next.plans) {
    const previous = planSnapshot(plan)
    plan.observing = false
    delete plan.high
    delete plan.lastQuoteDate
    delete plan.signal
    delete plan.signalDate
    appendPlanEvent(plan, {
      kind: 'restored',
      previous,
      reason: '恢复账本，保留历史并清除旧提醒及采样高点，等待新行情',
    })
  }
  projectBook(next)
  return next
}
