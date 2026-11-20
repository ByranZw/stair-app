import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { emptyBook, type Book } from '../src/domain/book'
import { correctAccount, projectBook, recordTrade } from '../src/domain/ledger'
import { openIndexedBook } from '../src/storage/indexed-book'

/** 历史先买再部分卖出，使更正必须重放中途现金而不能只看期末余额。 */
function accountBook(): Book {
  let book = emptyBook()
  book.accounts = [{ id: 'a', name: '原账户', openingCash: '75000', date: '2026-01-01' }]
  book.instruments = [
    { id: 'ETF:510300', code: '510300', name: '测试ETF', type: 'ETF', market: 'sh' },
  ]
  for (const [id, side, qty, price, date] of [
    ['buy', 'buy', '1000', '20', '2026-01-02'],
    ['sell', 'sell', '500', '25', '2026-01-03'],
  ] as const)
    book = recordTrade(book, {
      id,
      side,
      qty,
      price,
      date,
      accountId: 'a',
      instrumentId: 'ETF:510300',
      status: 'confirmed',
      time: '',
      sequence: book.trades.length + 1,
      orderConfirmed: false,
      fee: '2',
      pendingAmount: '',
    })
  return book
}

test('更正初始现金75000至80000后现金增加5000，持仓及真实资金流水不变', () => {
  const book = accountBook(),
    before = JSON.stringify(book),
    original = projectBook(book)
  const next = correctAccount(book, 'a', {
    name: '更正后账户',
    openingCash: '80000',
    date: '2026-01-01',
  })
  const result = projectBook(next)
  assert.equal(next.accounts[0].name, '更正后账户')
  assert.equal(result.cash.a, '72496.00')
  assert.equal(original.cash.a, '67496.00')
  assert.deepEqual(result.positions, original.positions)
  assert.deepEqual(result.trades, original.trades)
  assert.deepEqual(next.cashFlows, book.cashFlows)
  assert.equal(JSON.stringify(book), before)
})

test('更正后日期越过成交、历史中途现金不足、重名或未知账户都拒绝且原书不变', () => {
  const book = accountBook()
  book.accounts.push({ id: 'b', name: '另一账户', openingCash: '1000', date: '2026-01-01' })
  const before = JSON.stringify(book)
  for (const [id, input] of [
    ['a', { name: '原账户', openingCash: '75000', date: '2026-01-03' }],
    ['a', { name: '原账户', openingCash: '10000', date: '2026-01-01' }],
    ['a', { name: '另一账户', openingCash: '75000', date: '2026-01-01' }],
    ['missing', { name: '新名称', openingCash: '75000', date: '2026-01-01' }],
  ] as const) {
    assert.throws(() => correctAccount(book, id, input))
    assert.equal(JSON.stringify(book), before)
  }
})

test('账户更正与操作前副本同事务保存，过期版本不覆盖账本或副本', async () => {
  const db = await openIndexedBook('account-correction-' + Date.now())
  try {
    const original = accountBook()
    original.revision = 1
    await db.save(original, projectBook(original), 0)
    const next = correctAccount(original, 'a', {
      name: '原账户',
      openingCash: '80000',
      date: '2026-01-01',
    })
    next.revision = 2
    const recovery = { createdAt: '2026-01-04T00:00:00Z', book: original }
    await db.save(next, projectBook(next), 1, recovery)
    assert.deepEqual(await db.load(), next)
    assert.deepEqual(await db.loadRecovery(), recovery)
    const stale = correctAccount(original, 'a', {
      name: '旧预览',
      openingCash: '90000',
      date: '2026-01-01',
    })
    stale.revision = 2
    await assert.rejects(db.save(stale, projectBook(stale), 1, { ...recovery, book: stale }))
    assert.deepEqual(await db.load(), next)
    assert.deepEqual(await db.loadRecovery(), recovery)
  } finally {
    await db.close()
  }
})

test('旧账户编辑基准不能覆盖后来修改的现金，行情等无关版本变化不拦截', () => {
  const book = accountBook()
  const baseline = { ...book.accounts[0] }
  const updated = correctAccount(book, 'a', { ...baseline, openingCash: '80000' })
  assert.throws(
    () => correctAccount(updated, 'a', { ...baseline, name: '只改名称' }, baseline),
    /账户已更新/,
  )
  assert.equal(updated.accounts[0].openingCash, '80000')
  const quoteUpdated = { ...book, revision: book.revision + 1 }
  const renamed = correctAccount(quoteUpdated, 'a', { ...baseline, name: '只改名称' }, baseline)
  assert.equal(renamed.accounts[0].name, '只改名称')
  assert.equal(renamed.accounts[0].openingCash, '75000')
})
