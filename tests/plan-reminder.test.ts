import test from 'node:test'
import assert from 'node:assert/strict'
import type { Plan, PlanResult, Trade } from '../src/domain/book'
import type { Quote } from '../src/domain/market'
import { describePlanReminder } from '../src/domain/plan-reminder'
import { evaluatePlan, isStrategyQuoteFresh } from '../src/domain/strategy'

/** 固定中国交易日和双侧金价，验证提醒展示与真实策略使用同一价格方向。 */
function fixture() {
  const now = Date.parse('2026-11-20T02:00:00Z')
  const quote: Quote = {
    instrumentId: 'GOLD:CMB-GOLD',
    value: '760',
    buyValue: '765',
    date: '2026-11-20 10:00:00',
    fetchedAt: '2026-11-20T02:00:00Z',
    source: '招商银行',
    kind: 'market',
    tradable: true,
  }
  const plan: Plan = {
    id: 'p',
    accountId: 'a',
    instrumentId: quote.instrumentId,
    budget: '10000',
    parts: 10,
    drop: '4',
    observe: '15',
    retrace: '4',
    version: 1,
    createdAt: '2026-11-19T00:00:00Z',
    paused: false,
    observing: false,
  }
  const result: PlanResult = { id: 'p', used: '1603', reserved: '0', lastBuy: '800', ended: false }
  return { now, quote, plan, result }
}

test('真实跳跌信号显示一份预算、客户买入价与阈值，不改写计划', () => {
  const { now, quote, plan, result } = fixture()
  const triggered = evaluatePlan(plan, result, undefined, [], quote, true)
  const snapshot = JSON.stringify(triggered)
  const row = describePlanReminder(triggered, result, undefined, [], quote, undefined, now)
  assert.equal(row.kind, 'buy')
  assert.equal(row.actionable, true)
  assert.equal(row.threshold, '768')
  assert.equal(row.quoteValue, '765')
  assert.match(row.message, /一份 ¥1,000.00/)
  assert.equal(JSON.stringify(triggered), snapshot)
})

test('断网、过期、未交易和新报价尚未判断时，保存的信号只显示待核验', () => {
  const { now, quote, plan, result } = fixture()
  const triggered = {
    ...plan,
    signal: 'buy' as const,
    signalDate: quote.date,
    lastQuoteDate: quote.date,
  }
  for (const [q, error, time] of [
    [quote, '来源失败', now],
    [quote, undefined, now + 900000],
    [{ ...quote, tradable: false }, undefined, now],
    [{ ...quote, date: '2026-11-20 10:00:01' }, undefined, now],
  ] as const) {
    const row = describePlanReminder(triggered, result, undefined, [], q, error, time)
    assert.equal(row.kind, 'verify')
    assert.equal(row.actionable, false)
    assert.equal(row.attention, false)
    assert.equal(row.signalDate, quote.date)
  }
})

test('待确认、权益核对、暂停和已结束优先于旧信号，不出现执行按钮', () => {
  const { now, quote, plan, result } = fixture()
  const triggered = { ...plan, signal: 'sell' as const, lastQuoteDate: quote.date }
  const pending = { id: 't', planId: plan.id, status: 'pending' } as Trade
  for (const [p, r, trades, kind] of [
    [triggered, result, [pending], 'pending'],
    [triggered, { ...result, eventBlocked: true }, [], 'blocked'],
    [{ ...triggered, paused: true }, result, [], 'paused'],
    [triggered, { ...result, ended: true }, [], 'ended'],
  ] as const) {
    const row = describePlanReminder(p, r, undefined, [...trades], quote, undefined, now)
    assert.equal(row.kind, kind)
    assert.equal(row.actionable, false)
  }
})

test('止盈和观察使用客户卖出价、高点回撤线；无信号时不凭价格自行造信号', () => {
  const { now, quote, plan, result } = fixture()
  const observed = { ...plan, observing: true, high: '900', lastQuoteDate: quote.date }
  const watch = describePlanReminder(observed, result, undefined, [], quote, undefined, now)
  assert.equal(watch.kind, 'observe')
  assert.equal(watch.threshold, '864')
  const sell = describePlanReminder(
    { ...observed, signal: 'sell' },
    result,
    undefined,
    [],
    quote,
    undefined,
    now,
  )
  assert.equal(sell.kind, 'sell')
  assert.equal(sell.quoteValue, '760')
  assert.equal(sell.actionable, true)
  const idle = describePlanReminder(
    { ...plan, lastQuoteDate: quote.date },
    result,
    undefined,
    [],
    quote,
    undefined,
    now,
  )
  assert.equal(idle.kind, 'waiting')
  assert.equal(idle.actionable, false)
})

test('新鲜度保留15分钟与7日边界，未来日期和缺少有效报价等待核验', () => {
  const { now, quote, plan, result } = fixture()
  assert.equal(isStrategyQuoteFresh(quote, now + 899999), true)
  assert.equal(isStrategyQuoteFresh(quote, now + 900000), false)
  assert.equal(isStrategyQuoteFresh({ ...quote, date: '2026-11-13' }, now), true)
  assert.equal(isStrategyQuoteFresh({ ...quote, date: '2026-11-12' }, now), false)
  assert.equal(isStrategyQuoteFresh({ ...quote, date: '2026-11-21' }, now), false)
  const row = describePlanReminder(plan, result, undefined, [], undefined, undefined, now)
  assert.equal(row.kind, 'verify')
  assert.equal(row.attention, false)
  assert.equal(row.actionable, false)
})

test('持续加仓条件保留首次触发时刻，撤回后重触发才更新时间', () => {
  const { quote, plan, result } = fixture()
  const first = evaluatePlan(plan, result, undefined, [], quote, true)
  const later = evaluatePlan(
    first,
    result,
    undefined,
    [],
    { ...quote, date: '2026-11-20 10:01:00' },
    true,
  )
  assert.equal(later.signalDate, quote.date)
  const cancelled = evaluatePlan(
    later,
    result,
    undefined,
    [],
    { ...quote, value: '900', buyValue: '905', date: '2026-11-20 10:02:00' },
    true,
  )
  assert.equal(cancelled.signal, undefined)
  const again = evaluatePlan(
    cancelled,
    result,
    undefined,
    [],
    { ...quote, date: '2026-11-20 10:03:00' },
    true,
  )
  assert.equal(again.signalDate, '2026-11-20 10:03:00')
})

test('离线止盈及观察保留阈值身份，不误写成加仓价', () => {
  const { now, quote, plan, result } = fixture()
  for (const signal of [undefined, 'sell'] as const) {
    const row = describePlanReminder(
      { ...plan, observing: true, high: '900', signal, lastQuoteDate: quote.date },
      result,
      undefined,
      [],
      quote,
      '离线',
      now,
    )
    assert.equal(row.kind, 'verify')
    assert.equal(row.thresholdLabel, '回撤止盈价')
    assert.equal(row.threshold, '864')
  }
})

test('观察与加仓信号共存时始终显示加仓阈值，离线后也保留该身份', () => {
  const { now, quote, plan, result } = fixture()
  const position = {
    accountId: 'a',
    instrumentId: quote.instrumentId,
    qty: '1',
    totalCost: '600',
    unitCost: '600',
    realizedPnl: '0',
  }
  const current = { ...quote, value: '850', buyValue: '855' }
  const next = evaluatePlan(plan, { ...result, lastBuy: '1000' }, position, [], current, true)
  assert.equal(next.observing, true)
  assert.equal(next.signal, 'buy')
  for (const error of [undefined, '离线']) {
    const row = describePlanReminder(
      next,
      { ...result, lastBuy: '1000' },
      position,
      [],
      current,
      error,
      now,
    )
    assert.equal(row.thresholdLabel, '加仓参考价')
    assert.equal(row.threshold, '960')
  }
})
