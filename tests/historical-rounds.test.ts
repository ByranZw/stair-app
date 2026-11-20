import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBook, type Book, type Plan, type Trade } from '../src/domain/book'
import { projectBook } from '../src/domain/ledger'
import { chartReferences } from '../src/domain/chart'
import { discoverActions } from '../src/domain/discover-actions'

/** 同标的完成一轮后另开新轮，当前申请不能反向占用过去持仓。 */
function twoRounds(): Book {
  const book = emptyBook()
  book.accounts = [{ id: 'a', name: '历史轮次', date: '2026-01-01', openingCash: '50000' }]
  book.instruments = [{ id: 'FUND:110022', code: '110022', type: 'FUND', name: '测试基金' }]
  const plan: Plan = {
    id: 'p1',
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
    observing: false,
  }
  book.plans = [plan, { ...plan, id: 'p2', createdAt: '2026-01-04T00:00:00Z' }]
  const trade: Trade = {
    id: 'b1',
    accountId: 'a',
    instrumentId: plan.instrumentId,
    planId: 'p1',
    side: 'buy',
    date: '2026-01-02',
    time: '10:00',
    sequence: 1,
    qty: '100',
    price: '10',
    fee: '0',
    status: 'confirmed',
    orderConfirmed: false,
    pendingAmount: '',
  }
  book.trades = [
    trade,
    { ...trade, id: 's1', side: 'sell', date: '2026-01-03', sequence: 2 },
    { ...trade, id: 'b2', planId: 'p2', date: '2026-01-04', sequence: 3, qty: '200' },
    {
      ...trade,
      id: 's2',
      side: 'sell',
      planId: 'p2',
      date: '2026-01-05',
      sequence: 4,
      qty: '200',
      status: 'pending',
      price: '',
    },
  ]
  return book
}

test('历史投影与图表按当日持仓重放，不套用当前待确认预留和新轮次唯一约束', () => {
  const book = twoRounds()
  assert.equal(projectBook(book).plans.p1.ended, true)
  assert.equal(projectBook(book).positions['a/FUND:110022'].qty, '200')
  const historical = projectBook(book, '2026-01-02')
  assert.equal(historical.positions['a/FUND:110022'].qty, '100')
  assert.equal(historical.cash.a, '49000.00')
  assert.equal(historical.plans.p1.ended, false)
  assert.equal(historical.plans.p2.reserved, '0.00')
  assert.deepEqual(
    chartReferences(book, 'a', 'FUND:110022', ['2026-01-02', '2026-01-03', '2026-01-04']).map(
      (p) => p.cost,
    ),
    ['10', undefined, '10'],
  )
  assert.throws(
    () => projectBook({ ...book, trades: book.trades.filter((t) => t.id !== 's1') }),
    /同账户标的已有进行中计划/,
  )
})

test('多轮计划下仍可按权益日前持仓发现待核对公告，后来的申请不影响历史份额', () => {
  const book = twoRounds()
  const next = discoverActions(book, 'FUND:110022', [
    {
      type: 'dividend',
      date: '2026-01-03',
      cashPerShare: '0.1',
      ratio: '',
      source: '测试公开公告',
    },
  ])
  assert.equal(next.corporateActions?.length, 1)
  assert.equal(next.corporateActions![0].referenceQty, '100')
  assert.equal(next.corporateActions![0].status, 'pending')
  assert.equal(book.corporateActions?.length || 0, 0)
})
