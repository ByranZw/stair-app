import test from 'node:test'
import 'fake-indexeddb/auto'
import { openIndexedBook } from '../src/storage/indexed-book'
import assert from 'node:assert/strict'
import { emptyBook, type Book, type Trade } from '../src/domain/book'
import { deleteTrade, projectBook, recordTrade } from '../src/domain/ledger'

/** 两次不同成本买入和部分卖出，使删除前后历史成本及现金都有可核对差异。 */
function fixture(): Book {
  let book = emptyBook()
  book.accounts = [{ id: 'a', name: '删除验收', date: '2026-01-01', openingCash: '50000' }]
  book.instruments = [{ id: 'ETF:510300', code: '510300', name: '测试', type: 'ETF', market: 'sh' }]
  for (const [id, side, date, qty, price, fee] of [
    ['t1', 'buy', '2026-01-02', '100', '10', '10'],
    ['t2', 'buy', '2026-01-03', '100', '20', '10'],
    ['t3', 'sell', '2026-01-04', '50', '30', '5'],
  ] as const)
    book = recordTrade(book, {
      id,
      side,
      date,
      qty,
      price,
      fee,
      accountId: 'a',
      instrumentId: 'ETF:510300',
      status: 'confirmed',
      time: '10:00',
      sequence: book.trades.length + 1,
      orderConfirmed: false,
      pendingAmount: '',
    })
  return book
}

test('删除早期买入按剩余历史成本重算后续卖出，手续费和现金回退且输入不变', () => {
  const book = fixture(),
    before = JSON.stringify(book)
  const next = deleteTrade(book, 't1'),
    result = projectBook(next)
  assert.equal(result.trades.t3.realizedPnl, '490')
  assert.equal(result.positions['a/ETF:510300'].qty, '50')
  assert.equal(result.positions['a/ETF:510300'].totalCost, '1005')
  assert.equal(result.cash.a, '49485.00')
  assert.equal(JSON.stringify(book), before)
  assert.equal(
    next.trades.some((t) => t.id === 't1'),
    false,
  )
})

test('删除卖出恢复克份数量、成本和现金，不保留虚假卖出盈利', () => {
  const result = projectBook(deleteTrade(fixture(), 't3'))
  assert.equal(result.positions['a/ETF:510300'].qty, '200')
  assert.equal(result.positions['a/ETF:510300'].totalCost, '3020')
  assert.equal(result.cash.a, '46980.00')
  assert.equal(result.trades.t3, undefined)
})

test('删除被后续卖出依赖的买入拒绝且原书不变；未知ID也拒绝', () => {
  const book = fixture()
  book.trades = book.trades.filter((t) => t.id !== 't2')
  const before = JSON.stringify(book)
  assert.throws(() => deleteTrade(book, 't1'), /卖出数量超过/)
  assert.throws(() => deleteTrade(book, 'missing'), /不存在/)
  assert.equal(JSON.stringify(book), before)
})

test('删除确认成交只重置同账户同标的观察，其他账户及计划不变', () => {
  const book = fixture()
  book.accounts.push({ id: 'b', name: '另一账户', date: '2026-01-01', openingCash: '1000' })
  book.plans = ['a', 'b'].map((accountId) => ({
    id: accountId,
    accountId,
    instrumentId: 'ETF:510300',
    budget: '10000',
    parts: 10,
    drop: '4',
    observe: '15',
    retrace: '4',
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    paused: false,
    observing: true,
    high: '35',
    lastQuoteDate: '2026-01-04',
    signal: 'sell',
    signalDate: '2026-01-04',
  }))
  const next = deleteTrade(book, 't3')
  assert.equal(next.plans[0].high, undefined)
  assert.equal(next.plans[0].signal, undefined)
  assert.equal(next.plans[0].observing, false)
  assert.equal(next.plans[0].history?.at(-1)?.tradeId, 't3')
  assert.deepEqual(next.plans[1], book.plans[1])
  assert.equal(projectBook(next).cash.b, '1000.00')
})

for (const status of ['pending', 'cancelled'] as const)
  test(`删除${status}申请保留观察高点，只释放有效预留`, () => {
    const book: Book = JSON.parse(JSON.stringify(fixture()).replace(/ETF:510300/g, 'FUND:110022'))
    book.instruments[0] = { id: 'FUND:110022', code: '110022', name: '测试基金', type: 'FUND' }
    book.plans = [
      {
        id: 'p',
        accountId: 'a',
        instrumentId: 'FUND:110022',
        budget: '10000',
        parts: 10,
        drop: '4',
        observe: '15',
        retrace: '4',
        version: 1,
        createdAt: '2026-01-01T00:00:00Z',
        paused: false,
        observing: true,
        high: '35',
        lastQuoteDate: '2026-01-04',
      },
    ]
    const row: Trade = {
      ...book.trades[0],
      id: 'pending',
      planId: 'p',
      status,
      date: '2026-01-05',
      qty: '',
      price: '',
      fee: '1',
      pendingAmount: '100',
    }
    book.trades.push(row)
    const next = deleteTrade(book, row.id)
    assert.equal(next.plans[0].high, '35')
    assert.equal(next.plans[0].observing, true)
    assert.equal(next.plans[0].lastQuoteDate, '2026-01-04')
    assert.equal(projectBook(next).availableCash.a, projectBook(next).cash.a)
  })

test('删除与操作前副本同事务保存，过期版本不能覆盖账本或副本', async () => {
  const db = await openIndexedBook('deletion-' + Date.now())
  try {
    const original = fixture()
    original.revision = 1
    await db.save(original, projectBook(original), 0)
    const next = deleteTrade(original, 't3')
    next.revision = 2
    const recovery = { createdAt: '2026-01-06T00:00:00Z', book: original }
    await db.save(next, projectBook(next), 1, recovery)
    assert.deepEqual(await db.load(), next)
    assert.deepEqual(await db.loadRecovery(), recovery)
    const stale = deleteTrade(original, 't1')
    stale.revision = 2
    await assert.rejects(db.save(stale, projectBook(stale), 1, { ...recovery, book: stale }))
    assert.deepEqual(await db.load(), next)
    assert.deepEqual(await db.loadRecovery(), recovery)
  } finally {
    await db.close()
  }
})
