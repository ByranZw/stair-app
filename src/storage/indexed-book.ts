import { emptyBook, positionKey } from '../domain/book'
import type { Book } from '../domain/book'
import { validateBook } from '../domain/ledger'
import { entityTables } from './book-storage'
import type { BookStorage, Recovery } from './book-storage'

/** 浏览器账本使用真实IndexedDB事务，升级失败不清库、不回退到localStorage。 */
export async function openIndexedBook(name = 'stair-ledger'): Promise<BookStorage> {
  const database = await new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(name, 3)
    request.onupgradeneeded = () => {
      const db = request.result
      if (!db.objectStoreNames.contains('meta')) {
        const meta = db.createObjectStore('meta', { keyPath: 'id' })
        meta.put({ id: 'state', schema: 1, revision: 0 })
      }
      for (const table of [...entityTables, 'positions', 'recovery'])
        if (!db.objectStoreNames.contains(table)) db.createObjectStore(table, { keyPath: 'id' })
    }
    request.onsuccess = () => resolve(request.result)
    request.onerror = () => reject(new Error('账本数据库无法打开，请保留浏览器原数据'))
    request.onblocked = () => reject(new Error('请关闭其他正在使用账本的页面后重试'))
  })
  database.onversionchange = () => database.close()
  return {
    /** 一次只读事务读取同一版本的实体，避免读到跨次写入的半份账本。 */
    load() {
      return new Promise((resolve, reject) => {
        const book = emptyBook(),
          tx = database.transaction(['meta', ...entityTables], 'readonly')
        let failure: Error | undefined
        const metadata = tx.objectStore('meta').get('state')
        metadata.onsuccess = () => {
          if (metadata.result?.schema !== 1) {
            failure = new Error('账本版本不支持，请勿覆盖原数据')
            return
          }
          book.revision = metadata.result.revision
        }
        for (const table of entityTables) {
          const request = tx.objectStore(table).getAll()
          request.onsuccess = () => {
            Object.assign(book, { [table]: request.result })
          }
        }
        tx.oncomplete = () => {
          try {
            if (failure) throw failure
            validateBook(book)
            resolve(book)
          } catch (e) {
            reject(e)
          }
        }
        tx.onerror = () => reject(new Error('账本读取失败，请保留原数据'))
        tx.onabort = () => reject(new Error('账本读取已中止'))
      })
    },
    /** 原始实体、现金依据和持仓投影在一个事务写入；任一写入失败整体回滚。 */
    save(book, projection, expectedRevision, recovery) {
      validateBook(book)
      if (recovery) validateBook(recovery.book)
      if (book.revision !== expectedRevision + 1)
        return Promise.reject(new Error('账本写入版本不连续'))
      return new Promise((resolve, reject) => {
        const tx = database.transaction(
          ['meta', ...entityTables, 'positions', 'recovery'],
          'readwrite',
        )
        let failure = '账本保存失败，原数据已保留'
        const meta = tx.objectStore('meta').get('state')
        meta.onsuccess = () => {
          if (meta.result?.schema !== 1 || meta.result.revision !== expectedRevision) {
            failure = '账本已被其他页面修改，请重新载入后再保存'
            tx.abort()
            return
          }
          try {
            if (recovery) tx.objectStore('recovery').put({ id: 'before-restore', ...recovery })
            for (const table of entityTables) {
              const store = tx.objectStore(table)
              store.clear()
              for (const row of book[table] || []) store.put(row)
            }
            const positions = tx.objectStore('positions')
            positions.clear()
            for (const row of Object.values(projection.positions))
              positions.put({ id: positionKey(row.accountId, row.instrumentId), ...row })
            tx.objectStore('meta').put({ id: 'state', schema: 1, revision: book.revision })
          } catch {
            tx.abort()
          }
        }
        tx.oncomplete = () => resolve()
        tx.onabort = () => reject(new Error(failure))
        tx.onerror = () => {
          failure = '账本保存失败，本次事务已回滚'
        }
      })
    },
    /** 恢复前副本独立读取，普通记账不会覆盖它；损坏副本不能当空数据。 */
    loadRecovery() {
      return new Promise((resolve, reject) => {
        const tx = database.transaction('recovery', 'readonly'),
          request = tx.objectStore('recovery').get('before-restore')
        tx.oncomplete = () => {
          try {
            const row = request.result as Recovery | undefined
            if (row) validateBook(row.book)
            resolve(row ? { createdAt: row.createdAt, book: row.book } : undefined)
          } catch (error) {
            reject(error)
          }
        }
        tx.onabort = tx.onerror = () => reject(new Error('恢复前副本读取失败，请保留本地数据'))
      })
    },
    /** 页面/数据库生命周期结束时释放连接，允许后续版本升级。 */
    async close() {
      database.close()
    },
  }
}
