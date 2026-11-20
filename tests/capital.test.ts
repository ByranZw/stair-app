import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBook, type Book, type Trade } from '../src/domain/book'
import { projectBook, recordTrade } from '../src/domain/ledger'
import { summarizeCapital } from '../src/domain/capital'

/** 两个不同标的计划可核对账户预算；成交归属显式记录，不从持仓市值猜投入。 */
function capitalBook(): Book {
  const book = emptyBook()
  book.accounts = [{ id: 'a', name: '预算账户', openingCash: '75000', date: '2026-01-01' }]
  book.instruments = [
    { id: 'FUND:110022', code: '110022', name: '基金甲', type: 'FUND' },
    { id: 'FUND:110023', code: '110023', name: '基金乙', type: 'FUND' },
  ]
  book.plans = book.instruments.map((item, index) => ({
    id: 'p' + index,
    accountId: 'a',
    instrumentId: item.id,
    budget: index ? '20000' : '30000',
    parts: 10,
    drop: '4',
    observe: '15',
    retrace: '4',
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    paused: false,
    observing: false,
  }))
  return recordTrade(book, entry('buy', '20000'))
}

/** 以一元成交减少换算噪音，同时保留真实买卖、pending和计划重放入口。 */
function entry(side: 'buy' | 'sell', qty: string): Trade {
  return {
    id: 'buy',
    accountId: 'a',
    instrumentId: 'FUND:110022',
    planId: 'p0',
    side,
    status: 'confirmed',
    date: '2026-01-02',
    time: '',
    sequence: 1,
    orderConfirmed: true,
    qty,
    price: '1',
    fee: '0',
    pendingAmount: '',
  }
}

test('75000本金、50000计划预算已投20000，只预留剩余30000，自由资金25000', () => {
  const book = capitalBook(),
    before = JSON.stringify(book)
  const result = summarizeCapital(book, projectBook(book), 'a')
  assert.equal(result.cash, '55000.00')
  assert.equal(result.budget, '50000.00')
  assert.equal(result.used, '20000.00')
  assert.equal(result.remaining, '30000.00')
  assert.equal(result.free, '25000.00')
  assert.equal(result.plans.find((p) => p.planId === 'p0')?.perPart, '3000.00')
  assert.equal(JSON.stringify(book), before)
})

test('关联pending从现金可用额和计划未来需求同时转出，不重复减少自由资金', () => {
  const book = capitalBook()
  book.trades.push({
    ...entry('buy', ''),
    id: 'pending',
    status: 'pending',
    date: '2026-01-03',
    sequence: 2,
    price: '',
    pendingAmount: '3000',
    fee: '2',
  })
  const result = summarizeCapital(book, projectBook(book), 'a')
  assert.equal(result.cash, '55000.00')
  assert.equal(result.pending, '3002.00')
  assert.equal(result.available, '51998.00')
  assert.equal(result.planPending, '3002.00')
  assert.equal(result.remaining, '26998.00')
  assert.equal(result.free, '25000.00')
  book.trades[1].planId = undefined
  const unlinked = summarizeCapital(book, projectBook(book), 'a')
  assert.equal(unlinked.planPending, '0.00')
  assert.equal(unlinked.remaining, '30000.00')
  assert.equal(unlinked.free, '21998.00')
})

test('暂停仍预留，部分卖出不回填累计投入；清仓结束释放本轮剩余预算', () => {
  let book = capitalBook()
  book.plans[0].paused = true
  assert.equal(summarizeCapital(book, projectBook(book)).remaining, '30000.00')
  book = recordTrade(book, {
    ...entry('sell', '5000'),
    id: 'sell1',
    date: '2026-01-03',
    sequence: 2,
  })
  const partial = summarizeCapital(book, projectBook(book))
  assert.equal(partial.used, '20000.00')
  assert.equal(partial.remaining, '30000.00')
  assert.equal(partial.free, '30000.00')
  book = recordTrade(book, {
    ...entry('sell', '15000'),
    id: 'sell2',
    date: '2026-01-04',
    sequence: 3,
  })
  const ended = summarizeCapital(book, projectBook(book))
  assert.equal(ended.budget, '20000.00')
  assert.equal(ended.remaining, '20000.00')
  assert.equal(ended.free, '55000.00')
  assert.equal(ended.plans.find((p) => p.planId === 'p0')?.ended, true)
})

test('多账户分别计算，超配显示负自由资金而不冻结现金或拒绝账本', () => {
  const book = capitalBook()
  book.accounts.push({ id: 'b', name: '另一个账户', openingCash: '1000', date: '2026-01-01' })
  book.plans.push({ ...book.plans[0], id: 'pb', accountId: 'b', budget: '5000' })
  const projection = projectBook(book),
    b = summarizeCapital(book, projection, 'b')
  assert.equal(b.cash, '1000.00')
  assert.equal(b.available, '1000.00')
  assert.equal(b.free, '-4000.00')
  assert.equal(b.plans.length, 1)
  assert.equal(summarizeCapital(book, projection, 'a').free, '25000.00')
  assert.equal(summarizeCapital(book, projection).free, '21000.00')
})

test('全部账户自由资金为正仍揭示单账户缺口，其他账户余额不能自动抵消', () => {
  const book = capitalBook()
  book.plans[0].budget = '60000'
  book.plans[1].budget = '20000'
  book.accounts.push({ id: 'b', name: '备用账户', openingCash: '100000', date: '2026-01-01' })
  const projection = projectBook(book)
  const all = summarizeCapital(book, projection)
  assert.equal(all.free, '95000.00')
  assert.equal(all.shortfall, '5000.00')
  assert.equal(all.accounts.find((account) => account.accountId === 'a')?.free, '-5000.00')
  assert.equal(all.accounts.find((account) => account.accountId === 'b')?.free, '100000.00')
  const a = summarizeCapital(book, projection, 'a')
  assert.equal(a.free, '-5000.00')
  assert.equal(a.shortfall, '5000.00')
  assert.equal(a.accounts.length, 1)
  const b = summarizeCapital(book, projection, 'b')
  assert.equal(b.free, '100000.00')
  assert.equal(b.shortfall, '0.00')
  assert.equal(b.plans.length, 0)
})
