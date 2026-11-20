import type { Book, Projection } from '../domain/book'
/** 账本只在事务完成后返回新状态；expectedRevision防止多页面覆盖对方修改。 */
export interface BookStorage {
  load(): Promise<Book>
  save(
    book: Book,
    projection: Projection,
    expectedRevision: number,
    recovery?: Recovery,
  ): Promise<void>
  loadRecovery(): Promise<Recovery | undefined>
  close(): Promise<void>
}
/** 两端实体表名保持一致，持仓为同事务投影，公开行情缓存独立存储。 */
export const entityTables = [
  'accounts',
  'instruments',
  'openings',
  'trades',
  'cashFlows',
  'plans',
  'corporateActions',
] as const

/** 恢复操作前的最后一份账本，与替换操作同事务保存，仅保留最近一次。 */
export interface Recovery {
  createdAt: string
  book: Book
}
