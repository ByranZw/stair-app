import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBook, type Book, type Trade } from '../src/domain/book'
import { maintainOpening, maintainCashFlow } from '../src/domain/maintenance'
import { projectBook } from '../src/domain/ledger'

/** 独立初始持仓与现金，用于验证更正的完整账本重算。 */
function fixture(): Book {
  const book = emptyBook()
  book.accounts = [
    { id: 'a', name: '账户A', openingCash: '1000', date: '2026-01-01' },
    { id: 'b', name: '账户B', openingCash: '1000', date: '2026-01-01' },
  ]
  book.instruments = [
    { id: 'ETF:510300', code: '510300', name: '沪深300', type: 'ETF', market: 'sh' },
  ]
  book.openings = [
    {
      id: 'o',
      accountId: 'a',
      instrumentId: 'ETF:510300',
      date: '2026-01-02',
      qty: '100',
      totalCost: '800',
    },
  ]
  book.cashFlows = [
    { id: 'c', accountId: 'a', date: '2026-01-03', amount: '500', side: 'in', sequence: 1 },
  ]
  return book
}
/** 构造确定时间的实际交易，验证历史成本与现金依赖。 */
function trade(side: 'buy' | 'sell', qty: string, price: string): Trade {
  return {
    id: 't',
    accountId: 'a',
    instrumentId: 'ETF:510300',
    date: '2026-01-04',
    time: '10:00',
    side,
    status: 'confirmed',
    qty,
    price,
    fee: '0',
    sequence: 1,
    orderConfirmed: false,
    pendingAmount: '',
  }
}

test('初始成本更正重算历史已实现盈利与剩余成本，不改变现金', () => {
  const book = fixture()
  book.trades = [trade('sell', '20', '10')]
  const before = JSON.stringify(book)
  const next = maintainOpening(
    book,
    'o',
    { ...book.openings[0], totalCost: '600' },
    book.openings[0],
  )
  const p = projectBook(next)
  assert.equal(p.positions['a/ETF:510300'].totalCost, '480')
  assert.equal(p.trades.t.realizedPnl, '80')
  assert.equal(p.cash.a, '1700.00')
  assert.equal(JSON.stringify(book), before)
})

test('删除或减少初始数量引起后续卖出不足时，指出交易且不改原账本', () => {
  const book = fixture()
  book.trades = [trade('sell', '20', '10')]
  const original = JSON.stringify(book)
  for (const input of [null, { ...book.openings[0], qty: '10' }])
    assert.throws(
      () => maintainOpening(book, 'o', input),
      /2026-01-04 沪深300，卖出 20，可用 (0|10)/,
    )
  assert.equal(JSON.stringify(book), original)
})

test('更正归属、删除无依赖基准和重复基准检查', () => {
  const book = fixture()
  const moved = maintainOpening(book, 'o', { ...book.openings[0], accountId: 'b' })
  assert.equal(projectBook(moved).positions['b/ETF:510300'].qty, '100')
  assert.equal(projectBook(moved).positions['a/ETF:510300'], undefined)
  assert.equal(maintainOpening(book, 'o', null).openings.length, 0)
  book.openings.push({ ...book.openings[0], id: 'other', accountId: 'b' })
  assert.throws(
    () => maintainOpening(book, 'o', { ...book.openings[0], accountId: 'b' }),
    /只允许一个导入基准/,
  )
})

test('更正基准日期不能覆盖已记录的更早交易', () => {
  const book = fixture()
  book.trades = [trade('buy', '10', '10')]
  assert.throws(
    () => maintainOpening(book, 'o', { ...book.openings[0], date: '2026-01-05' }),
    /2026-01-04 沪深300/,
  )
})

test('资金更正保留序号，删除转入或改转出后允许负现金且不污染原数据', () => {
  const book = fixture()
  const input = { accountId: 'b', date: '2026-01-03', amount: '200', side: 'out' as const }
  const next = maintainCashFlow(book, 'c', input, book.cashFlows[0])
  assert.equal(next.cashFlows[0].sequence, 1)
  assert.equal(projectBook(next).cash.b, '800.00')
  assert.equal(projectBook(maintainCashFlow(book, 'c', null)).cash.a, '1000.00')
  book.trades = [trade('buy', '140', '10')]
  const original = JSON.stringify(book)
  assert.equal(projectBook(maintainCashFlow(book, 'c', null)).cash.a, '-400.00')
  const changed = maintainCashFlow(book, 'c', { ...input, accountId: 'a', amount: '2000' })
  assert.equal(changed.cashFlows[0].sequence, 1)
  assert.equal(projectBook(changed).cash.a, '-2400.00')
  assert.equal(JSON.stringify(book), original)
})

test('过期编辑基准被拒绝，无变化保存不重置计划，初始持仓变化仅重置关联计划', () => {
  const book = fixture()
  const basePlan = {
    id: 'p',
    accountId: 'a',
    instrumentId: 'ETF:510300',
    budget: '1000',
    parts: 10,
    drop: '4',
    observe: '15',
    retrace: '4',
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    paused: false,
    observing: true,
    high: '12',
    signal: 'sell' as const,
    signalDate: '2026-01-04',
    lastQuoteDate: '2026-01-04',
  }
  book.plans = [basePlan, { ...basePlan, id: 'p2', accountId: 'b' }]
  const { id: _, ...input } = book.openings[0]
  assert.equal(maintainOpening(book, 'o', input), book)
  const next = maintainOpening(book, 'o', { ...input, totalCost: '600' })
  assert.equal(next.plans[0].observing, false)
  assert.equal(next.plans[0].high, undefined)
  assert.equal(next.plans[0].history?.[0].kind, 'opening')
  assert.equal(next.plans[1].high, '12')
  assert.throws(() => maintainOpening(next, 'o', input, book.openings[0]), /已修改/)
  assert.throws(
    () => maintainCashFlow(book, 'c', null, { ...book.cashFlows[0], amount: '400' }),
    /已修改/,
  )
  assert.throws(() => maintainOpening(book, 'missing', null), /已删除/)
})
