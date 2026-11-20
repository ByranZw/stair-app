import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBook, type Book, type Trade } from '../src/domain/book'
import { recordTrade, correctTrade, projectBook } from '../src/domain/ledger'
import { createBackup, readBackup } from '../src/domain/backup'
import { convertGold } from '../src/domain/gold-entry'

/** 固定历史成交与后续部分卖出，核对更正必须影响后续成本与盈利。 */
function fixture(): Book {
  const book = emptyBook()
  book.accounts = [{ id: 'a', name: '更正验收', date: '2026-01-01', openingCash: '50000' }]
  book.instruments = [{ id: 'ETF:510300', code: '510300', name: '测试', type: 'ETF', market: 'sh' }]
  let next = book
  for (const [index, side, date, qty, price, fee] of [
    [1, 'buy', '2026-01-02', '100', '10', '10'],
    [2, 'buy', '2026-01-03', '100', '20', '10'],
    [3, 'sell', '2026-01-04', '50', '30', '5'],
  ] as const)
    next = recordTrade(next, {
      id: 't' + index,
      accountId: 'a',
      instrumentId: 'ETF:510300',
      side,
      date,
      qty,
      price,
      fee,
      status: 'confirmed',
      time: '10:00',
      sequence: index,
      orderConfirmed: false,
      pendingAmount: '',
    })
  return next
}

test('更正过去买入重放后续卖出成本/净盈亏，保留原值，重复提交幂等且备份保留审计', () => {
  const book = fixture(),
    original = JSON.stringify(book)
  assert.equal(projectBook(book).trades.t3.realizedPnl, '740')
  const input: Trade = { ...book.trades[0], price: '12' }
  const next = correctTrade(book, input)
  const result = projectBook(next)
  assert.equal(result.trades.t3.realizedPnl, '690')
  assert.equal(result.positions['a/ETF:510300'].totalCost, '2415')
  assert.equal(result.positions['a/ETF:510300'].qty, '150')
  assert.equal(result.cash.a, '48275.00')
  assert.equal(JSON.stringify(book), original)
  assert.equal(next.trades.find((t) => t.id === 't1')?.corrections?.[0].previous.price, '10')
  assert.equal(correctTrade(next, input), next)
  const twice = correctTrade(next, { ...input, price: '14' })
  const changes = twice.trades.find((t) => t.id === 't1')!.corrections!
  assert.deepEqual(
    changes.map((c) => c.previous.price),
    ['10', '12'],
  )
  assert.deepEqual(readBackup(createBackup(twice)).book, JSON.parse(JSON.stringify(twice)))
})

test('非法更正拒绝且不改原账本，只有已确认成交允许更正', () => {
  const book = fixture(),
    before = JSON.stringify(book)
  assert.throws(() => correctTrade(book, { ...book.trades[2], qty: '250' }), /卖出数量超过/)
  assert.throws(() => correctTrade(book, { ...book.trades[0], status: 'pending' }), /只能更正/)
  assert.equal(JSON.stringify(book), before)
})

test('更正归属对新旧账户完整重放，保留原ID和稳定记录顺序', () => {
  const book = fixture()
  book.trades = [book.trades[0]]
  book.accounts.push({ id: 'b', name: '另一账户', date: '2026-01-01', openingCash: '10000' })
  const next = correctTrade(book, { ...book.trades[0], accountId: 'b', sequence: 999 })
  const result = projectBook(next)
  assert.equal(result.cash.a, '50000.00')
  assert.equal(result.cash.b, '8990.00')
  assert.equal(result.positions['b/ETF:510300'].qty, '100')
  assert.equal(next.trades[0].id, 't1')
  assert.equal(next.trades[0].sequence, 1)
  assert.equal(next.trades[0].corrections![0].previous.accountId, 'a')
})

test('黄金克元按实际价双向换算，保留到分金额与最多8位参考克重', () => {
  assert.equal(convertGold('1', '803.3', '克'), '803.30')
  assert.equal(convertGold('803.30', '803.3', '元'), '1')
  assert.equal(convertGold('750', '600', '元'), '1.25')
  assert.equal(convertGold('750', '800', '元'), '0.9375')
  assert.equal(convertGold('1', '3', '元'), '0.33333333')
  assert.throws(() => convertGold('1', '0', '元'), /单价/)
})
