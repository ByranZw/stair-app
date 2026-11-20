import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import 'fake-indexeddb/auto'
import { emptyBook } from '../src/domain/book'
import { projectBook, recordTrade } from '../src/domain/ledger'
import {
  createBackup,
  readBackup,
  prepareRestoredBook,
  MAX_BACKUP_BYTES,
} from '../src/domain/backup'
import { openIndexedBook } from '../src/storage/indexed-book'
import { entityTables } from '../src/storage/book-storage'
import type { Book } from '../src/domain/book'

/** 同时含中文、黄金、导入、部分卖出、基金申请、独立参数的离线账本。 */
function fixture(): Book {
  let b = emptyBook()
  b.accounts = [
    { id: 'account-a', name: '招行积存金与基金', date: '2026-01-01', openingCash: '50000' },
  ]
  b.instruments = [
    { id: 'GOLD:CMB-GOLD', code: 'CMB-GOLD', name: '招行积存金', type: 'GOLD' },
    { id: 'FUND:110022', code: '110022', name: '测试基金', type: 'FUND' },
  ]
  b.openings = [
    {
      id: 'opening-a',
      accountId: 'account-a',
      instrumentId: 'GOLD:CMB-GOLD',
      date: '2026-01-02',
      qty: '1.234567',
      totalCost: '700.01',
    },
  ]
  b.cashFlows = [
    {
      id: 'cash-a',
      accountId: 'account-a',
      date: '2026-01-03',
      side: 'in',
      amount: '100.55',
      sequence: 1,
    },
  ]
  b.plans = [
    {
      id: 'plan-a',
      accountId: 'account-a',
      instrumentId: 'GOLD:CMB-GOLD',
      budget: '30000',
      parts: 10,
      drop: '4',
      observe: '15',
      retrace: '4',
      createdAt: '2026-01-02T00:00:00Z',
      version: 2,
      paused: true,
      observing: false,
    },
  ]
  b = recordTrade(b, {
    id: 'trade-a',
    accountId: 'account-a',
    instrumentId: 'GOLD:CMB-GOLD',
    planId: 'plan-a',
    side: 'sell',
    status: 'confirmed',
    date: '2026-01-04',
    time: '10:00',
    sequence: 2,
    orderConfirmed: false,
    qty: '0.234567',
    price: '800',
    fee: '2',
    pendingAmount: '',
  })
  b = recordTrade(b, {
    id: 'trade-b',
    accountId: 'account-a',
    instrumentId: 'FUND:110022',
    side: 'buy',
    status: 'pending',
    date: '2026-01-05',
    time: '',
    sequence: 3,
    orderConfirmed: false,
    qty: '',
    price: '',
    fee: '1.50',
    pendingAmount: '1000',
  })
  b.revision = 37
  return b
}
/** 用Node独立哈希实现为畸形业务数据签名，验证哈希通过也不能绕过领域校验。 */
function resign(data: unknown): string {
  const backup = data as Record<string, unknown>
  const content = {
    format: backup.format,
    schemaVersion: backup.schemaVersion,
    createdAt: backup.createdAt,
    book: backup.book,
  }
  const canonical = JSON.stringify(content, (_key, value) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.keys(value)
            .sort()
            .map((k) => [k, value[k]]),
        )
      : value,
  )
  backup.checksum = {
    algorithm: 'SHA-256',
    value: createHash('sha256').update(canonical).digest('hex'),
  }
  return JSON.stringify(backup)
}

/** 实体表读取顺序由主键决定，比较全部实体内容与投影而非偶然数组顺序。 */
function assertSameBook(actual: Book, expected: Book): void {
  const normalize = (book: Book) => {
    const copy: Book = JSON.parse(JSON.stringify(book))
    for (const table of entityTables) (copy[table] || []).sort((a, b) => a.id.localeCompare(b.id))
    return copy
  }
  assert.deepEqual(normalize(actual), normalize(expected))
  assert.deepEqual(projectBook(actual), projectBook(expected))
}

test('完整账本备份往返保留十进制文本、中文、现金、历史盈利和待确认预留', () => {
  const b = fixture(),
    before = JSON.stringify(b),
    text = createBackup(b),
    restored = readBackup(text)
  assert.deepEqual(restored.book, b)
  assert.deepEqual(projectBook(restored.book), projectBook(b))
  assert.equal(JSON.stringify(b), before)
  const root = JSON.parse(text)
  assert.equal(root.book.revision, 37)
  assert(!('positions' in root.book))
  assert(!text.includes('fetchedAt'))
})
test('校验算法与Node SHA256一致，JSON缩进或键顺序变化不损坏同一内容', () => {
  const root = JSON.parse(createBackup(fixture()))
  assert.equal(readBackup(resign(root)).checksum.value, root.checksum.value)
  const shuffled = {
    book: root.book,
    createdAt: root.createdAt,
    format: root.format,
    checksum: root.checksum,
    schemaVersion: root.schemaVersion,
  }
  assert.deepEqual(readBackup('\uFEFF' + JSON.stringify(shuffled)).book, root.book)
})
test('损坏、改动、错误应用、未知备份或账本版本均拒绝，不修改原对象', () => {
  const b = fixture(),
    original = JSON.stringify(b)
  assert.throws(() => readBackup('{'), /有效的JSON/)
  const edited = JSON.parse(createBackup(b))
  edited.book.accounts[0].openingCash = '60000'
  assert.throws(() => readBackup(JSON.stringify(edited)), /校验不通过/)
  edited.schemaVersion = 99
  assert.throws(() => readBackup(JSON.stringify(edited)), /版本暂不支持/)
  edited.schemaVersion = 1
  edited.book.schema = 99
  assert.throws(() => readBackup(JSON.stringify(edited)), /版本暂不支持/)
  edited.format = 'other-app'
  assert.throws(() => readBackup(JSON.stringify(edited)), /不是拾阶/)
  assert.equal(JSON.stringify(b), original)
})
test('即使重算校验和，超卖、失效关联、原型键标识和非法信号仍不能恢复', () => {
  const root = JSON.parse(createBackup(fixture()))
  root.book.trades[0].qty = '100'
  assert.throws(() => readBackup(resign(root)), /当时持仓/)
  root.book.trades[0].qty = '0.234567'
  root.book.trades[0].accountId = 'missing'
  assert.throws(() => readBackup(resign(root)), /不存在/)
  const other = JSON.parse(createBackup(fixture()))
  other.book.accounts[0].id = '__proto__'
  assert.throws(() => readBackup(resign(other)), /标识/)
  const signal = JSON.parse(createBackup(fixture()))
  signal.book.plans[0].signal = 'unknown'
  assert.throws(() => readBackup(resign(signal)), /提醒类型/)
})
test('恢复只重置策略观察与提醒，成交、预算、上次买价和手动暂停保持原值', () => {
  const b = fixture()
  Object.assign(b.plans[0], {
    observing: true,
    high: '1000',
    lastQuoteDate: '2026-01-04',
    signal: 'sell',
    signalDate: '2026-01-04',
    initialLastBuy: '600',
  })
  const next = prepareRestoredBook(b)
  assert.equal(next.plans[0].observing, false)
  assert.equal(next.plans[0].paused, true)
  assert.equal(next.plans[0].initialLastBuy, '600')
  assert.equal(next.plans[0].signal, undefined)
  assert.equal(next.plans[0].high, undefined)
  assert.deepEqual(next.trades, b.trades)
  assert.deepEqual(projectBook(next), projectBook(b))
  assert.equal(b.plans[0].high, '1000')
})
test('备份大小按UTF8字节数拒绝，空账本可以独立备份恢复', () => {
  assert.throws(() => readBackup('中'.repeat(Math.floor(MAX_BACKUP_BYTES / 3) + 1)), /超过10MB/)
  assert.deepEqual(readBackup(createBackup(emptyBook())).book, emptyBook())
})
test('从旧IndexedDB v1升级只加恢复副本表，不丢原账户或交易', async () => {
  const name = 'upgrade-' + Date.now(),
    b = fixture()
  await new Promise<void>((resolve, reject) => {
    const request = indexedDB.open(name, 1)
    request.onupgradeneeded = () => {
      const db = request.result
      db.createObjectStore('meta', { keyPath: 'id' }).put({
        id: 'state',
        schema: 1,
        revision: b.revision,
      })
      for (const table of [...entityTables, 'positions'] as const) {
        const store = db.createObjectStore(table, { keyPath: 'id' })
        if (table !== 'positions') for (const row of b[table] || []) store.put(row)
      }
    }
    request.onerror = () => reject(request.error)
    request.onsuccess = () => {
      request.result.close()
      resolve()
    }
  })
  const db = await openIndexedBook(name)
  assertSameBook(await db.load(), b)
  assert.equal(await db.loadRecovery(), undefined)
  await db.close()
})
test('原子恢复提交新账本并保留旧账本；普通记账不覆盖恢复前副本，失败不覆盖已有副本', async () => {
  const db = await openIndexedBook('restore-' + Date.now()),
    b = fixture()
  b.revision = 1
  await db.save(b, projectBook(b), 0)
  const replacement = emptyBook()
  replacement.revision = 2
  const recovery = { createdAt: '2026-01-06T00:00:00Z', book: b }
  await db.save(replacement, projectBook(replacement), 1, recovery)
  assert.deepEqual(await db.loadRecovery(), recovery)
  assert.equal((await db.load()).accounts.length, 0)
  replacement.revision = 3
  await db.save(replacement, projectBook(replacement), 2)
  assert.deepEqual(await db.loadRecovery(), recovery)
  const bad = fixture()
  bad.revision = 4
  Object.assign(bad.accounts[0], { bad: () => undefined })
  await assert.rejects(
    db.save(bad, projectBook(bad), 3, { createdAt: '2026-01-07T00:00:00Z', book: replacement }),
    /回滚|保留/,
  )
  assert.deepEqual(await db.loadRecovery(), recovery)
  assert.equal((await db.load()).revision, 3)
  assert.equal((await db.load()).accounts.length, 0)
  await db.close()
})
test('恢复时旧本机版本拒绝，原账本与恢复副本均不被覆盖', async () => {
  const db = await openIndexedBook('conflict-' + Date.now()),
    b = fixture()
  b.revision = 1
  await db.save(b, projectBook(b), 0)
  const other = emptyBook()
  other.revision = 1
  await assert.rejects(
    db.save(other, projectBook(other), 0, { createdAt: '2026-01-06T00:00:00Z', book: emptyBook() }),
    /其他页面修改/,
  )
  assertSameBook(await db.load(), b)
  assert.equal(await db.loadRecovery(), undefined)
  await db.close()
})
