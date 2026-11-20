import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBook } from '../src/domain/book'
import type { Book, Trade, Plan } from '../src/domain/book'
import { correctTrade, projectBook, recordTrade, validateBook } from '../src/domain/ledger'
import { createBackup, readBackup } from '../src/domain/backup'
import {
  currencyOf,
  validInstrument,
  quoteCnyValue,
  quoteInCny,
  priceInCurrency,
} from '../src/domain/currency'
import { describePlanReminder } from '../src/domain/plan-reminder'
import { recordQuoteHistory } from '../src/domain/plan-history'
import { prepareRestoredBook } from '../src/domain/backup'
import { evaluatePlan } from '../src/domain/strategy'
import type { Quote } from '../src/domain/market'

/** 跨市场相同代码仍使用独立身份，账户所有资金固定为人民币。 */
function fixture(): Book {
  const book = emptyBook()
  book.accounts = [{ id: 'a', name: '人民币账户', openingCash: '10000', date: '2026-01-01' }]
  book.instruments = [
    {
      id: 'STOCK:us:BRK.B',
      code: 'BRK.B',
      name: '伯克希尔',
      type: 'STOCK',
      market: 'us',
      currency: 'USD',
    },
  ]
  return book
}
/** 原币价格与人民币实际净额故意不按当前汇率简单相乘，以验证历史资金独立。 */
function trade(id: string, side: 'buy' | 'sell', net?: string): Trade {
  return {
    id,
    accountId: 'a',
    instrumentId: 'STOCK:us:BRK.B',
    side,
    status: 'confirmed',
    date: side === 'buy' ? '2026-01-02' : '2026-01-03',
    time: '10:00',
    sequence: 1,
    orderConfirmed: false,
    qty: '2',
    price: '100',
    fee: '5',
    pendingAmount: '',
    ...(net ? { settlementAmount: net } : {}),
  }
}
/** 策略参数预算与成本、采样高点都采用人民币。 */
function plan(): Plan {
  return {
    id: 'p',
    accountId: 'a',
    instrumentId: 'STOCK:us:BRK.B',
    budget: '5000',
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
/** 独立汇率快照使报价原币与账户估值分离。 */
function quote(): Quote {
  return {
    instrumentId: 'STOCK:us:BRK.B',
    value: '100',
    date: '2026-01-04 10:00',
    fetchedAt: '2026-01-04T02:00:00Z',
    source: '测试',
    kind: 'market',
    currency: 'USD',
    fxRate: '7',
    fxDate: '2026-01-04',
  }
}
test('海外买卖现金、持仓成本与已实现收益只取实际人民币净额', () => {
  let book = recordTrade(fixture(), trade('b', 'buy', '1410'))
  const bought = projectBook(book)
  assert.equal(bought.cash.a, '8590.00')
  assert.equal(bought.positions['a/STOCK:us:BRK.B'].totalCost, '1410')
  assert.equal(bought.trades.b.gross, '1405.00')
  book = recordTrade(book, trade('s', 'sell', '1500'))
  const sold = projectBook(book)
  assert.equal(sold.cash.a, '10090.00')
  assert.equal(sold.trades.s.realizedPnl, '90')
  assert.equal(sold.trades.s.gross, '1505.00')
})
test('海外结算额必填，手续费不可超过买入支出，境内不接受外币结算覆盖', () => {
  assert.throws(() => recordTrade(fixture(), trade('b', 'buy')), /人民币结算金额/)
  assert.throws(() => recordTrade(fixture(), trade('b', 'buy', '5')), /大于手续费/)
  const book = fixture()
  book.instruments = [{ id: 'ETF:510300', code: '510300', name: 'ETF', type: 'ETF', market: 'sh' }]
  assert.throws(
    () => recordTrade(book, { ...trade('b', 'buy', '100'), instrumentId: 'ETF:510300' }),
    /境内成交/,
  )
})
test('计划消耗及下档买点使用人民币成交本金，汇率参与策略比较', () => {
  const b = fixture()
  b.plans = [plan()]
  const book = recordTrade(b, { ...trade('b', 'buy', '1410'), planId: 'p' })
  const p = projectBook(book)
  assert.equal(p.plans.p.used, '1410.00')
  assert.equal(p.plans.p.lastBuy, '702.5')
  const q = quote()
  q.value = '96'
  q.fxRate = '7'
  assert.equal(
    evaluatePlan(
      book.plans[0],
      p.plans.p,
      p.positions['a/STOCK:us:BRK.B'],
      book.trades,
      quoteInCny(q)!,
      true,
    ).signal,
    'buy',
  )
  q.fxRate = '8'
  assert.equal(
    evaluatePlan(
      book.plans[0],
      p.plans.p,
      p.positions['a/STOCK:us:BRK.B'],
      book.trades,
      quoteInCny(q)!,
      true,
    ).signal,
    undefined,
  )
})
test('汇率缺失不估值，原币图表参考可逆，人民币转换重复调用不重复乘汇率', () => {
  const q = quote()
  assert.equal(quoteCnyValue(q), '700')
  assert.equal(priceInCurrency('700', q), '100')
  assert.equal(quoteCnyValue(quoteInCny(q)!), '700')
  delete q.fxRate
  assert.equal(quoteCnyValue(q), undefined)
})
test('股票身份币种校验与schema1备份、更正历史保留人民币净额', () => {
  let book = recordTrade(fixture(), trade('b', 'buy', '1410'))
  book = correctTrade(book, { ...book.trades[0], settlementAmount: '1420' })
  const restored = readBackup(createBackup(book)).book
  assert.equal(restored.schema, 1)
  assert.equal(restored.trades[0].corrections?.[0].previous.settlementAmount, '1410')
  assert.equal(projectBook(restored).cash.a, '8580.00')
  assert(validInstrument(book.instruments[0]))
  assert.equal(currencyOf(book.instruments[0]), 'USD')
  assert(!validInstrument({ ...book.instruments[0], currency: 'CNY' }))
  const old = emptyBook()
  old.accounts = book.accounts
  old.instruments = [{ id: 'FUND:110022', code: '110022', name: '老基金', type: 'FUND' }]
  assert.equal(readBackup(createBackup(old)).book.instruments[0].currency, undefined)
})

test('同一美股收盘价使用更新汇率跨档提醒，旧原价或旧汇率均不能覆盖', () => {
  const original = plan()
  const result = { id: 'p', used: '0.00', reserved: '0.00', lastBuy: '750', ended: false }
  const q = quote()
  q.fxRate = '7.5'
  q.fxDate = '2026-01-04 10:00:00'
  const first = evaluatePlan(original, result, undefined, [], quoteInCny(q)!, true)
  assert.equal(first.signal, undefined)
  q.fxRate = '7'
  q.fxDate = '2026-01-04 11:00:00'
  const second = evaluatePlan(first, result, undefined, [], quoteInCny(q)!, true)
  assert.equal(second.signal, 'buy')
  assert.equal(second.lastFxDate, q.fxDate)
  const now = Date.parse(q.fetchedAt)
  assert.equal(
    describePlanReminder(first, result, undefined, [], quoteInCny(q)!, undefined, now).kind,
    'verify',
  )
  assert.equal(
    describePlanReminder(second, result, undefined, [], quoteInCny(q)!, undefined, now).kind,
    'buy',
  )
  const history = recordQuoteHistory(first, second, quoteInCny(q)!, result)
  assert.equal(history.history?.[0].quote?.fxRate, '7')
  assert.equal(history.history?.[0].quote?.fxDate, q.fxDate)
  assert.equal(history.history?.[0].quote?.currency, 'CNY')
  const oldFx = { ...q, fxDate: '2026-01-04 09:00:00', fxRate: '8' }
  assert.deepEqual(evaluatePlan(second, result, undefined, [], quoteInCny(oldFx)!, true), second)
  const oldStock = { ...q, date: '2026-01-03 10:00', fxDate: '2026-01-04 12:00:00' }
  assert.deepEqual(evaluatePlan(second, result, undefined, [], quoteInCny(oldStock)!, true), second)
  const book = fixture()
  book.plans = [history]
  assert.equal(readBackup(createBackup(book)).book.plans[0].lastFxDate, q.fxDate)
  assert.equal(prepareRestoredBook(book).plans[0].lastFxDate, undefined)
})

test('真实十位美元及港币汇率折算后能保存观察高点及历史并重载备份', () => {
  for (const [market, code, currency, fxRate, value] of [
    ['us', 'AAPL', 'USD', '6.6777000000', '271.49'],
    ['hk', '00700', 'HKD', '0.8521662065', '542.12345678'],
  ] as const) {
    const book = fixture()
    const item = {
      id: `STOCK:${market}:${code}`,
      market,
      code,
      currency,
      type: 'STOCK' as const,
      name: code,
    }
    book.instruments = [item]
    const p = { ...plan(), instrumentId: item.id, initialLastBuy: '100.1234567890123456789' }
    const raw = {
      ...quote(),
      instrumentId: item.id,
      currency,
      fxRate,
      value,
      fxDate: '2026-01-04 10:00:00',
    }
    const cny = quoteInCny(raw)!
    const result = { id: 'p', used: '0.00', reserved: '0.00', ended: false }
    const position = {
      accountId: 'a',
      instrumentId: item.id,
      qty: '1',
      totalCost: '100',
      unitCost: '100',
      realizedPnl: '0',
    }
    const next = evaluatePlan(p, result, position, [], cny, true)
    assert.equal(next.observing, true)
    assert.equal(next.high, cny.value)
    book.plans = [recordQuoteHistory(p, next, cny, result, position)]
    validateBook(book)
    const restored = readBackup(createBackup(book)).book
    assert.equal(restored.plans[0].high, cny.value)
    assert.equal(restored.plans[0].history?.[0].quote?.fxRate, fxRate)
  }
  assert.throws(
    () => recordTrade(fixture(), { ...trade('b', 'buy', '100'), price: '1.123456789' }),
    /最多8位/,
  )
})
