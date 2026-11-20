import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { emptyBook } from '../src/domain/book'
import type { Book, Trade } from '../src/domain/book'
import { recordTrade, projectBook } from '../src/domain/ledger'
import { evaluatePlan } from '../src/domain/strategy'
import { openIndexedBook } from '../src/storage/indexed-book'

/** 已持有100份且观察到1.30，申请之前的有效净值与高点均可追溯。 */
function observingBook(): Book {
  const book = emptyBook()
  book.accounts = [{ id: 'a', name: '申赎跟踪回归', openingCash: '1000', date: '2026-01-01' }]
  book.instruments = [{ id: 'FUND:110022', code: '110022', name: '测试基金', type: 'FUND' }]
  book.openings = [
    {
      id: 'o',
      accountId: 'a',
      instrumentId: 'FUND:110022',
      date: '2026-01-01',
      qty: '100',
      totalCost: '100',
    },
  ]
  book.plans = [
    {
      id: 'p',
      accountId: 'a',
      instrumentId: 'FUND:110022',
      budget: '1000',
      parts: 10,
      drop: '4',
      observe: '15',
      retrace: '4',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      paused: false,
      observing: true,
      high: '1.30',
      lastQuoteDate: '2026-01-02',
    },
  ]
  return book
}

/** 待确认申购仅预留金额，赎回仅预留份额，不提前填入成交价。 */
function application(side: 'buy' | 'sell'): Trade {
  return {
    id: 't',
    accountId: 'a',
    instrumentId: 'FUND:110022',
    planId: 'p',
    side,
    status: 'pending',
    date: '2026-01-03',
    time: '',
    sequence: 1,
    orderConfirmed: false,
    qty: side === 'sell' ? '10' : '',
    price: '',
    fee: '0',
    pendingAmount: side === 'buy' ? '10' : '',
  }
}

/** 用同一条正式净值触发原1.30高点的4%回撤，避免申请重置造成漏报。 */
function atRetracement(book: Book) {
  const projected = projectBook(book)
  return evaluatePlan(
    book.plans[0],
    projected.plans.p,
    projected.positions['a/FUND:110022'],
    book.trades,
    {
      instrumentId: 'FUND:110022',
      value: '1.248',
      date: '2026-01-04',
      fetchedAt: '2026-01-04T12:00:00Z',
      source: '测试正式净值',
      kind: 'nav',
    },
    true,
  )
}

for (const side of ['buy', 'sell'] as const) {
  test(`已观察计划提交待确认${side === 'buy' ? '申购' : '赎回'}仍以原高点触发止盈`, () => {
    const original = observingBook()
    const next = recordTrade(original, application(side))
    assert.equal(next.plans[0].observing, true)
    assert.equal(next.plans[0].high, '1.30')
    assert.equal(next.plans[0].lastQuoteDate, '2026-01-02')
    assert.equal(projectBook(next).positions['a/FUND:110022'].qty, '100')
    assert.equal(atRetracement(next).signal, 'sell')
    assert.deepEqual(original, observingBook())
    assert.equal(next.plans[0].history!.at(-1)!.snapshot.high, '1.30')
  })
}

test('申请及撤销经数据库往返后保留高点；实际确认才重置跟踪', async () => {
  const storage = await openIndexedBook('pending-strategy-' + Date.now())
  try {
    let next = recordTrade(observingBook(), application('sell'))
    next.revision = 1
    await storage.save(next, projectBook(next), 0)
    next = await storage.load()
    next.trades[0].status = 'cancelled'
    next.revision = 2
    await storage.save(next, projectBook(next), 1)
    next = await storage.load()
    assert.equal(next.plans[0].high, '1.30')
    assert.equal(atRetracement(next).signal, 'sell')
    const pending = recordTrade(observingBook(), application('buy'))
    const confirmed = recordTrade(
      pending,
      {
        ...pending.trades[0],
        status: 'confirmed',
        date: '2026-01-05',
        qty: '10',
        price: '1.2',
      },
      false,
      't',
    )
    assert.equal(confirmed.plans[0].observing, false)
    assert.equal(confirmed.plans[0].high, undefined)
    assert.equal(confirmed.plans[0].lastQuoteDate, undefined)
    assert.equal(projectBook(confirmed).positions['a/FUND:110022'].qty, '110')
    assert.equal(confirmed.trades[0].applicationDate, '2026-01-03')
  } finally {
    storage.close()
  }
})

test('申请不撤回有效卖出提醒，只撤回被预留阻止的买入提醒', () => {
  const original = observingBook()
  original.plans[0].signal = 'sell'
  original.plans[0].signalDate = '2026-01-02'
  const selling = recordTrade(original, application('sell'))
  assert.equal(selling.plans[0].signal, 'sell')
  assert.equal(selling.plans[0].signalDate, '2026-01-02')
  original.plans[0].signal = 'buy'
  const buying = recordTrade(original, application('buy'))
  assert.equal(buying.plans[0].signal, undefined)
  assert.equal(buying.plans[0].signalDate, undefined)
  assert.equal(buying.plans[0].high, '1.30')
})
