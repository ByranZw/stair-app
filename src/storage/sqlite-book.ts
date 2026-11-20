import { emptyBook, positionKey } from '../domain/book'
import type { Book } from '../domain/book'
import { validateBook } from '../domain/ledger'
import { entityTables } from './book-storage'
import type { BookStorage, Recovery } from './book-storage'

const name = 'stair-ledger',
  path = '_doc/stair-ledger.db'
/** SQL只对固定表名操作；用户文本转义单引号，不能成为SQL片段。 */
function literal(text: string): string {
  return "'" + text.replace(/'/g, "''") + "'"
}
/** 将SQLite回调转换为可组合的事务步骤，失败直接中断。 */
function execute(sql: string | string[]): Promise<void> {
  return new Promise((resolve, reject) =>
    plus.sqlite.executeSql({
      name,
      sql: Array.isArray(sql) ? sql : [sql],
      success: () => resolve(),
      fail: () => reject(new Error('SQLite账本写入失败')),
    }),
  )
}
/** 查询固定内部语句，不向页面开放任意SQL。 */
function select(sql: string): Promise<{ id: string; payload: string }[]> {
  return new Promise((resolve, reject) =>
    plus.sqlite.selectSql({
      name,
      sql,
      success: (rows) => resolve(rows),
      fail: () => reject(new Error('SQLite账本读取失败')),
    }),
  )
}
/** begin/commit/rollback由同一连接执行，串行队列防止事务交错。 */
function transaction(operation: 'begin' | 'commit' | 'rollback'): Promise<void> {
  return new Promise((resolve, reject) =>
    plus.sqlite.transaction({
      name,
      operation,
      success: () => resolve(),
      fail: () => reject(new Error('SQLite账本事务失败')),
    }),
  )
}

/** App使用私有_doc目录；不支持SQLite时明确失败，不降级为不可靠资金缓存。 */
export async function openSqliteBook(): Promise<BookStorage> {
  if (!plus.sqlite) throw new Error('当前安卓基座未包含SQLite模块，请使用支持该模块的基座')
  if (!plus.sqlite.isOpenDatabase({ name, path }))
    await new Promise<void>((resolve, reject) =>
      plus.sqlite.openDatabase({
        name,
        path,
        success: () => resolve(),
        fail: () => reject(new Error('无法打开本地账本数据库')),
      }),
    )
  await execute([
    'CREATE TABLE IF NOT EXISTS meta (id TEXT PRIMARY KEY, payload TEXT NOT NULL)',
    ...entityTables.map(
      (table) => `CREATE TABLE IF NOT EXISTS ${table} (id TEXT PRIMARY KEY, payload TEXT NOT NULL)`,
    ),
    'CREATE TABLE IF NOT EXISTS recovery (id TEXT PRIMARY KEY, payload TEXT NOT NULL)',
    'CREATE TABLE IF NOT EXISTS positions (id TEXT PRIMARY KEY, payload TEXT NOT NULL)',
    `INSERT OR IGNORE INTO meta VALUES ('state','{"schema":1,"revision":0}')`,
  ])
  let queue: Promise<unknown> = Promise.resolve()
  /** 所有账本读写按顺序使用连接，事务结束后才允许下一操作。 */
  function enqueue<T>(action: () => Promise<T>): Promise<T> {
    const next = queue.then(action)
    queue = next.catch(() => undefined)
    return next
  }
  return {
    /** 事务内读取同一版本，失败回滚并保留原数据库。 */
    load() {
      return enqueue(async () => {
        await transaction('begin')
        try {
          const metadata = JSON.parse(
            (await select("SELECT * FROM meta WHERE id='state'"))[0].payload,
          )
          if (metadata.schema !== 1) throw new Error('账本版本不支持，请勿覆盖原数据')
          const book: Book = emptyBook()
          book.revision = metadata.revision
          for (const table of entityTables)
            Object.assign(book, {
              [table]: (await select(`SELECT * FROM ${table}`)).map((row) =>
                JSON.parse(row.payload),
              ),
            })
          validateBook(book)
          await transaction('commit')
          return book
        } catch (error) {
          await transaction('rollback')
          throw error
        }
      })
    },
    /** 比较版本后原子替换个人小账本实体与投影，任何SQL失败都回滚。 */
    save(book, projection, expectedRevision, recovery) {
      return enqueue(async () => {
        validateBook(book)
        if (recovery) validateBook(recovery.book)
        if (book.revision !== expectedRevision + 1) throw new Error('账本写入版本不连续')
        await transaction('begin')
        try {
          const metadata = JSON.parse(
            (await select("SELECT * FROM meta WHERE id='state'"))[0].payload,
          )
          if (metadata.schema !== 1 || metadata.revision !== expectedRevision)
            throw new Error('账本已被其他页面修改，请重新载入后再保存')
          const commands: string[] = []
          if (recovery)
            commands.push(
              `INSERT OR REPLACE INTO recovery VALUES ('before-restore',${literal(JSON.stringify(recovery))})`,
            )
          for (const table of entityTables) {
            commands.push(`DELETE FROM ${table}`)
            for (const row of book[table] || [])
              commands.push(
                `INSERT INTO ${table} VALUES (${literal(row.id)},${literal(JSON.stringify(row))})`,
              )
          }
          commands.push('DELETE FROM positions')
          for (const row of Object.values(projection.positions))
            commands.push(
              `INSERT INTO positions VALUES (${literal(positionKey(row.accountId, row.instrumentId))},${literal(JSON.stringify(row))})`,
            )
          commands.push(
            `UPDATE meta SET payload=${literal(JSON.stringify({ schema: 1, revision: book.revision }))} WHERE id='state'`,
          )
          await execute(commands)
          await transaction('commit')
        } catch (error) {
          await transaction('rollback')
          throw error
        }
      })
    },
    /** 同一连接读取最后一次恢复前副本，JSON或实体校验失败直接报告。 */
    loadRecovery() {
      return enqueue(async () => {
        const rows = await select("SELECT * FROM recovery WHERE id='before-restore'")
        if (!rows.length) return undefined
        const recovery: Recovery = JSON.parse(rows[0].payload)
        validateBook(recovery.book)
        return recovery
      })
    },
    /** 不再使用账本时等待在途操作结束并释放数据库连接。 */
    close() {
      return enqueue(
        () =>
          new Promise<void>((resolve, reject) =>
            plus.sqlite.closeDatabase({
              name,
              success: () => resolve(),
              fail: () => reject(new Error('账本数据库关闭失败')),
            }),
          ),
      )
    },
  }
}
