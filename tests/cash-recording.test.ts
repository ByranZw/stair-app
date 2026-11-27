import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { emptyBook, type Book, type Plan, type Trade } from '../src/domain/book'
import { correctTrade, deleteTrade, projectBook, recordTrade } from '../src/domain/ledger'
import { createBackup, prepareRestoredBook, readBackup } from '../src/domain/backup'
import { summarizeCapital } from '../src/domain/capital'
import { evaluatePlan } from '../src/domain/strategy'
import { openIndexedBook } from '../src/storage/indexed-book'

/** 用零现金与独立第二账户复现补记，不依赖真实用户资金或行情。 */
function fixture(): Book {
  const book = emptyBook()
  book.accounts = [
    { id: 'a', name: '补记账户', openingCash: '0', date: '2026-01-01' },
    { id: 'b', name: '独立账户', openingCash: '2000', date: '2026-01-01' },
  ]
  book.instruments = [
    { id: 'ETF:510300', code: '510300', name: '沪深300', type: 'ETF', market: 'sh' },
    { id: 'FUND:110022', code: '110022', name: '测试基金', type: 'FUND' },
  ]
  return book
}

/** 固定日期与费用，验证不足现金下的真实数量、成本与净收支。 */
function trade(id: string, extra: Partial<Trade> = {}): Trade {
  return {
    id,
    accountId: 'a',
    instrumentId: 'ETF:510300',
    date: '2026-01-02',
    time: '10:00',
    side: 'buy',
    status: 'confirmed',
    qty: '100',
    price: '10',
    fee: '1',
    pendingAmount: '',
    sequence: 1,
    orderConfirmed: false,
    ...extra,
  }
}

/** 预算仅用于规划与提醒，不构成补记成交的授权上限。 */
function plan(instrumentId = 'ETF:510300'): Plan {
  return {
    id: 'p',
    accountId: 'a',
    instrumentId,
    budget: '500',
    parts: 10,
    drop: '4',
    observe: '15',
    retrace: '4',
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    paused: false,
    observing: false,
  }
}

test('零现金补记买入和后续加仓均成功，负现金不归零、不借用其他账户、不伪造入金', () => {
  const original = fixture()
  const before = JSON.stringify(original)
  let book = recordTrade(original, trade('first'))
  book = recordTrade(book, trade('second', { date: '2026-01-03', qty: '10', price: '12' }))
  const result = projectBook(book)
  assert.equal(result.cash.a, '-1122.00')
  assert.equal(result.availableCash.a, '-1122.00')
  assert.equal(result.cash.b, '2000.00')
  assert.equal(result.positions['a/ETF:510300'].qty, '110')
  assert.equal(result.positions['a/ETF:510300'].totalCost, '1122')
  assert.equal(result.trades.first.net, '1001.00')
  assert.deepEqual(book.cashFlows, [])
  assert.equal(JSON.stringify(original), before)
})

test('回溯日期出现现金缺口仍可补记，迟到入金和部分卖出按各自日期重放', () => {
  let book = fixture()
  book.cashFlows = [
    { id: 'funding', accountId: 'a', date: '2026-01-04', side: 'in', amount: '1500', sequence: 1 },
  ]
  book = recordTrade(book, trade('buy'))
  book = recordTrade(
    book,
    trade('sell', { date: '2026-01-03', side: 'sell', qty: '20', price: '11' }),
  )
  assert.equal(projectBook(book, '2026-01-02').cash.a, '-1001.00')
  assert.equal(projectBook(book, '2026-01-03').cash.a, '-782.00')
  const result = projectBook(book)
  assert.equal(result.cash.a, '718.00')
  assert.equal(result.positions['a/ETF:510300'].qty, '80')
  assert.equal(result.positions['a/ETF:510300'].totalCost, '800.8')
  assert.equal(result.trades.sell.realizedPnl, '18.8')
  assert.equal(book.cashFlows.length, 1)
})

test('补记转出和未完全补足缺口的转入均可保存，不要求补齐历史资金', () => {
  const book = fixture()
  book.cashFlows = [
    { id: 'out', accountId: 'a', date: '2026-01-02', side: 'out', amount: '50', sequence: 1 },
    { id: 'in', accountId: 'a', date: '2026-01-03', side: 'in', amount: '25', sequence: 2 },
  ]
  assert.equal(projectBook(book, '2026-01-02').cash.a, '-50.00')
  assert.equal(projectBook(book).cash.a, '-25.00')
})

test('场外申请超过现金和计划预算仍可登记，确认仅记一次实际支出，撤销只释放预留', () => {
  const original = fixture()
  original.plans = [plan('FUND:110022')]
  const pending = trade('application', {
    instrumentId: 'FUND:110022',
    planId: 'p',
    status: 'pending',
    pendingAmount: '1000',
    qty: '',
    price: '',
    fee: '2',
  })
  const book = recordTrade(original, pending)
  assert.equal(projectBook(book).cash.a, '0.00')
  assert.equal(projectBook(book).availableCash.a, '-1002.00')
  assert.equal(projectBook(book).plans.p.reserved, '1002.00')
  const confirmed = recordTrade(
    book,
    { ...pending, date: '2026-01-03', status: 'confirmed', qty: '500', price: '2' },
    false,
    pending.id,
  )
  const result = projectBook(confirmed)
  assert.equal(confirmed.trades.length, 1)
  assert.equal(result.cash.a, '-1002.00')
  assert.equal(result.availableCash.a, '-1002.00')
  assert.equal(result.positions['a/FUND:110022'].qty, '500')
  assert.equal(result.plans.p.used, '1002.00')
  assert.equal(result.plans.p.reserved, '0.00')
  const cancelled = { ...book, trades: [{ ...pending, status: 'cancelled' as const }] }
  assert.equal(projectBook(cancelled).availableCash.a, '0.00')
  assert.equal(projectBook(cancelled).plans.p.reserved, '0.00')
})

test('实际成交可超过关联计划预算，保留真实含费投入且预算耗尽不再提示加仓', () => {
  const original = fixture()
  original.plans = [plan()]
  const book = recordTrade(original, trade('buy', { planId: 'p' }))
  const result = projectBook(book)
  assert.equal(result.plans.p.used, '1001.00')
  const capital = summarizeCapital(book, result, 'a')
  assert.equal(capital.plans[0].remaining, '0.00')
  assert.equal(capital.free, '-1001.00')
  const evaluated = evaluatePlan(
    book.plans[0],
    result.plans.p,
    result.positions['a/ETF:510300'],
    book.trades,
    {
      instrumentId: 'ETF:510300',
      value: '8',
      date: '2026-01-03T10:00:00',
      source: 'test',
      fetchedAt: '2026-01-03T02:00:00Z',
      kind: 'market',
    },
    true,
  )
  assert.equal(evaluated.signal, undefined)
})

test('更正买入及删除卖出导致负现金仍可保存，成本重算并保留修改前账本', () => {
  let book = recordTrade(fixture(), trade('buy'))
  book = recordTrade(
    book,
    trade('sell', { date: '2026-01-03', side: 'sell', qty: '20', price: '11' }),
  )
  const before = JSON.stringify(book)
  const changed = correctTrade(book, { ...book.trades[0], price: '12' })
  assert.equal(projectBook(changed).cash.a, '-982.00')
  assert.equal(projectBook(changed).positions['a/ETF:510300'].totalCost, '960.8')
  const removed = deleteTrade(changed, 'sell')
  assert.equal(projectBook(removed).cash.a, '-1201.00')
  assert.equal(projectBook(removed).positions['a/ETF:510300'].qty, '100')
  assert.equal(JSON.stringify(book), before)
})

test('负现金账本可持久保存、重载、备份和恢复，不改原始资金及交易金额', async () => {
  const book = recordTrade(fixture(), trade('buy'))
  book.revision = 1
  const storage = await openIndexedBook('negative-cash-' + Date.now())
  try {
    await storage.save(book, projectBook(book), 0)
    const loaded = (await storage.load())!
    assert.deepEqual(loaded, book)
    const restored = prepareRestoredBook(readBackup(createBackup(loaded)).book)
    assert.deepEqual(restored, book)
    assert.equal(projectBook(restored).cash.a, '-1001.00')
    assert.equal(restored.accounts[0].openingCash, '0')
    assert.deepEqual(restored.cashFlows, [])
  } finally {
    await storage.close()
  }
})

test('放开现金不放开无效成交输入、未知账户或无持仓卖出', () => {
  const book = fixture()
  const before = JSON.stringify(book)
  for (const invalid of [
    trade('zero', { qty: '0' }),
    trade('negative', { price: '-1' }),
    trade('fee', { fee: '-1' }),
    trade('unknown', { accountId: 'missing' }),
    trade('sell', { side: 'sell' }),
  ])
    assert.throws(() => recordTrade(book, invalid))
  assert.equal(JSON.stringify(book), before)
})
