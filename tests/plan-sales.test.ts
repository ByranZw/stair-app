import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBook } from '../src/domain/book'
import { projectBook, recordTrade } from '../src/domain/ledger'
import { summarizePlanSales } from '../src/domain/plan-sales'

test('清仓卖出收益率按含费结转成本计算，与预算大小无关', () => {
  let book = emptyBook()
  const item = {
    id: 'ETF:510300',
    code: '510300',
    name: '测试ETF',
    type: 'ETF' as const,
    market: 'sh' as const,
  }
  book.accounts = [{ id: 'a', name: '测试账户', openingCash: '2000', date: '2026-01-01' }]
  book.instruments = [item]
  book.plans = [
    {
      id: 'p',
      accountId: 'a',
      instrumentId: item.id,
      budget: '10000',
      parts: 10,
      drop: '4',
      observe: '15',
      retrace: '4',
      version: 1,
      createdAt: '2026-01-01T00:00:00Z',
      paused: false,
      observing: false,
    },
  ]
  for (const [index, side, price] of [
    [1, 'buy', '4.2'],
    [2, 'sell', '4.5'],
  ] as const)
    book = recordTrade(book, {
      id: String(index),
      accountId: 'a',
      instrumentId: item.id,
      planId: 'p',
      side,
      status: 'confirmed',
      date: `2026-01-0${index + 1}`,
      time: '',
      sequence: index,
      orderConfirmed: true,
      qty: '100',
      price,
      fee: '3',
      pendingAmount: '',
    })
  const summary = summarizePlanSales(book, projectBook(book), 'p')
  assert.equal(summary.net.toString(), '447')
  assert.equal(summary.cost.toString(), '423')
  assert.equal(summary.pnl.toString(), '24')
  assert.equal(summary.pct?.toFixed(2), '5.67')
  assert.equal(summarizePlanSales(book, projectBook(book), 'other').pct, undefined)
})
