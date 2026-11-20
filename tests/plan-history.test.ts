import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import type { Plan, PlanResult, Position } from '../src/domain/book'
import { emptyBook } from '../src/domain/book'
import type { Quote } from '../src/domain/market'
import { evaluatePlan } from '../src/domain/strategy'
import { appendPlanEvent, planSnapshot, recordQuoteHistory } from '../src/domain/plan-history'
import { projectBook, recordTrade } from '../src/domain/ledger'
import { createBackup, readBackup, prepareRestoredBook } from '../src/domain/backup'
import { openIndexedBook } from '../src/storage/indexed-book'

/** 固定参数与行情使提醒边界、采样高点和版本变化可重复验证。 */
function fixture() {
  const plan: Plan = {
    id: 'p',
    accountId: 'a',
    instrumentId: 'ETF:510300',
    budget: '50000',
    parts: 10,
    drop: '4',
    observe: '15',
    retrace: '4',
    version: 1,
    createdAt: '2026-01-01T00:00:00Z',
    paused: false,
    observing: false,
  }
  const result: PlanResult = {
    id: 'p',
    used: '5000.00',
    reserved: '0.00',
    lastBuy: '10',
    ended: false,
  }
  const position: Position = {
    accountId: 'a',
    instrumentId: plan.instrumentId,
    qty: '100',
    totalCost: '1000',
    unitCost: '10',
    realizedPnl: '0',
  }
  const quote: Quote = {
    instrumentId: plan.instrumentId,
    value: '9.6',
    date: '2026-01-02T10:00:00',
    source: '测试正式来源',
    fetchedAt: '2026-01-02T02:00:00Z',
    kind: 'market',
  }
  const book = emptyBook()
  book.accounts = [{ id: 'a', name: '历史验证', openingCash: '50000', date: '2026-01-01' }]
  book.instruments = [
    { id: plan.instrumentId, code: '510300', name: '测试ETF', type: 'ETF', market: 'sh' },
  ]
  book.plans = [plan]
  return { plan, result, position, quote, book }
}

test('多档跳跌只记录首次一份提醒，重复或更新报价不重复追加；反弹撤回单独留痕', () => {
  const { plan, result, position, quote } = fixture()
  const first = recordQuoteHistory(
    plan,
    evaluatePlan(plan, result, position, [], { ...quote, value: '8' }, true),
    { ...quote, value: '8' },
    result,
    position,
  )
  assert.equal(first.history!.length, 1)
  assert.equal(first.history![0].basis!.buyAt, '9.6')
  assert.equal(first.history![0].basis!.lastBuy, '10')
  assert.equal(first.history![0].quote!.value, '8')
  assert.equal(first.history![0].quote!.source, quote.source)
  assert.equal(first.history![0].snapshot.signal, 'buy')
  assert.equal(plan.history, undefined)
  for (const q of [quote, { ...quote, date: '2026-01-02T11:00:00', value: '9' }]) {
    const next = recordQuoteHistory(
      first,
      evaluatePlan(first, result, position, [], q, true),
      q,
      result,
      position,
    )
    assert.equal(next.history!.length, 1)
  }
  const bounce = { ...quote, date: '2026-01-02T12:00:00', value: '10' }
  const next = recordQuoteHistory(
    first,
    evaluatePlan(first, result, position, [], bounce, true),
    bounce,
    result,
    position,
  )
  assert.equal(next.history!.length, 2)
  assert.match(next.history![1].reason, /撤回/)
})

test('止盈观察、采样高点与回撤依据各自保留，不被后来参数或行情污染', () => {
  const { plan, result, position, quote } = fixture()
  let next = plan
  for (const [hour, value] of [
    ['10', '11.5'],
    ['11', '12'],
    ['12', '11.52'],
  ]) {
    const q = { ...quote, value, date: `2026-01-02T${hour}:00:00` }
    next = recordQuoteHistory(
      next,
      evaluatePlan(next, result, position, [], q, true),
      q,
      result,
      position,
    )
  }
  assert.equal(next.history!.length, 3)
  assert.equal(next.history![0].snapshot.high, '11.5')
  assert.equal(next.history![1].basis!.sellAt, '11.52')
  assert.equal(next.history![2].snapshot.signal, 'sell')
  assert.equal(next.history![2].basis!.unitCost, '10')
  const previous = planSnapshot(next)
  next = { ...next, version: 2, drop: '5', observing: false, high: undefined, signal: undefined }
  appendPlanEvent(next, { kind: 'parameters', reason: '用户调整参数', previous })
  assert.equal(next.history![3].previous!.drop, '4')
  assert.equal(next.history![3].snapshot.drop, '5')
  next.drop = '6'
  assert.equal(next.history![3].snapshot.drop, '5')
})

test('缓存/过期/倒序/暂停/已结束和事件报价不产生伪提醒历史', () => {
  const { plan, result, position, quote } = fixture()
  for (const [p, r, q, eligible] of [
    [plan, result, quote, false],
    [{ ...plan, paused: true }, result, quote, true],
    [plan, { ...result, ended: true }, quote, true],
    [plan, result, { ...quote, corporateAction: true }, true],
    [{ ...plan, lastQuoteDate: '2026-01-03' }, result, quote, true],
  ] as const) {
    const next = recordQuoteHistory(
      p,
      evaluatePlan(p, r, position, [], q, eligible),
      q,
      r,
      position,
    )
    assert.equal(next.history, undefined)
  }
})

test('历史随备份和事务保存；恢复追加记录且原有依据不被清除，老计划兼容无历史', async () => {
  const { book, plan, result, position, quote } = fixture()
  projectBook(book)
  book.plans = [
    recordQuoteHistory(
      plan,
      evaluatePlan(plan, result, position, [], quote, true),
      quote,
      result,
      position,
    ),
  ]
  const backup = readBackup(createBackup(book)).book
  assert.deepEqual(backup, book)
  const next = prepareRestoredBook(backup)
  assert.equal(next.plans[0].signal, undefined)
  assert.equal(next.plans[0].history!.length, 2)
  assert.equal(next.plans[0].history![0].snapshot.signal, 'buy')
  assert.equal(next.plans[0].history![1].kind, 'restored')
  assert.equal(next.plans[0].history![1].previous!.signal, 'buy')
  assert.equal(book.plans[0].history!.length, 1)
  const db = await openIndexedBook('history-' + Date.now())
  next.revision = 1
  await db.save(next, projectBook(next), 0)
  assert.deepEqual(await db.load(), next)
  await db.close()
})

test('畸形或重复历史被拒绝，生成计算价格的小数和科学计数法可合法保存', () => {
  const { book, plan } = fixture()
  appendPlanEvent(plan, {
    kind: 'created',
    reason: '新建',
    basis: { used: '0.00', reserved: '0.00', unitCost: '1e-8', buyAt: '0.0000000096' },
  })
  projectBook(book)
  plan.history![0].basis!.unitCost = '1e1000000'
  assert.throws(() => projectBook(book), /历史参考价/)
  plan.history![0].basis!.unitCost = '1e-8'
  plan.history![0].snapshot.drop = '100'
  assert.throws(() => projectBook(book), /历史跌幅/)
  plan.history![0].snapshot.drop = '4'
  plan.history!.push({ ...plan.history![0] })
  assert.throws(() => projectBook(book), /历史记录/)
})

test('实际成交和清仓在同一领域操作留痕，幂等重试与失败不新增记录', () => {
  const { book, plan } = fixture()
  const trade = {
    id: 't1',
    accountId: 'a',
    instrumentId: plan.instrumentId,
    planId: plan.id,
    side: 'buy' as const,
    status: 'confirmed' as const,
    date: '2026-01-02',
    time: '10:00',
    sequence: 1,
    orderConfirmed: false,
    qty: '100',
    price: '10',
    fee: '1',
    pendingAmount: '',
  }
  const bought = recordTrade(book, trade)
  assert.equal(bought.plans[0].history!.length, 1)
  assert.equal(bought.plans[0].history![0].tradeId, 't1')
  assert.equal(book.plans[0].history, undefined)
  assert.equal(recordTrade(bought, trade), bought)
  const sell = {
    ...trade,
    id: 't2',
    side: 'sell' as const,
    date: '2026-01-03',
    sequence: 2,
    price: '11',
  }
  assert.throws(() => recordTrade(bought, { ...sell, qty: '101' }), /超过成交当时持仓/)
  assert.equal(bought.plans[0].history!.length, 1)
  const sold = recordTrade(bought, sell)
  assert.equal(sold.plans[0].history!.length, 2)
  assert.match(sold.plans[0].history![1].reason, /本轮已结束/)
})
