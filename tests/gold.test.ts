import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { parseGold } from '../src/services/parsers'
import { evaluatePlan } from '../src/domain/strategy'
import { recordQuoteHistory } from '../src/domain/plan-history'
import type { Instrument, Quote } from '../src/domain/market'
import type { Plan, PlanResult, Position } from '../src/domain/book'

const gold: Instrument = {
  id: 'GOLD:CMB-GOLD',
  code: 'CMB-GOLD',
  name: '招行黄金账户',
  type: 'GOLD',
}
const plan: Plan = {
  id: 'p',
  accountId: 'a',
  instrumentId: gold.id,
  budget: '10000',
  parts: 10,
  drop: '4',
  observe: '15',
  retrace: '4',
  version: 1,
  createdAt: '2026-11-01T01:00:00Z',
  paused: false,
  observing: false,
}
const derived: PlanResult = { id: 'p', used: '1000', reserved: '0', lastBuy: '1000', ended: false }
const position: Position = {
  accountId: 'a',
  instrumentId: gold.id,
  qty: '1',
  totalCost: '1000',
  unitCost: '1000',
  realizedPnl: '0',
}
const quote: Quote = {
  instrumentId: gold.id,
  value: '959',
  buyValue: '964',
  date: '2026-11-19 12:00:00',
  source: '招行黄金账户',
  kind: 'market',
  fetchedAt: '2026-11-19T04:00:00Z',
  tradable: true,
}

test('真实招行样本按客户侧映射，卖价用于估值，银行报价刷新不再生产本机采样', () => {
  const raw = JSON.parse(readFileSync(new URL('./fixtures/cmb-gold.json', import.meta.url), 'utf8'))
  const result = parseGold(raw, gold)
  assert.equal(result.quote.buyValue, '803.21')
  assert.equal(result.quote.value, '798.21')
  assert.equal(result.quote.tradable, true)
  assert.deepEqual(result.history.points, [])
  assert.match(result.history.source, /上金所/)
  assert.equal(result.history.resolution, 'day')
  raw.data.QuotedPrice = false
  const closed = parseGold(raw, gold)
  assert.equal(closed.quote.tradable, false)
  assert.equal(closed.history.points.length, 0)
  raw.data.FQAMBPRCZ1.zBuyPrc = '790'
  assert.throws(() => parseGold(raw, gold), /方向异常/)
})
test('黄金卖价跌穿不等于买价跌穿，加仓严格用客户买入价', () => {
  assert.equal(evaluatePlan(plan, derived, position, [], quote, true).signal, undefined)
  const falling = { ...quote, buyValue: '959', value: '954' }
  const next = evaluatePlan(plan, derived, position, [], falling, true)
  assert.equal(next.signal, 'buy')
  const recorded = recordQuoteHistory(plan, next, falling, derived, position)
  assert.equal(recorded.history?.[0].quote?.buyValue, '959')
  assert.equal(recorded.history?.[0].quote?.value, '954')
})
test('黄金观察及回撤用可赎回卖价，非交易报价不能生成新提醒', () => {
  const observed = { ...plan, observing: true, high: '1200' }
  const fall = { ...quote, buyValue: '1155', value: '1149' }
  assert.equal(evaluatePlan(observed, derived, position, [], fall, true).signal, 'sell')
  assert.deepEqual(
    evaluatePlan(observed, derived, position, [], { ...fall, tradable: false }, true),
    observed,
  )
  assert.equal(
    evaluatePlan(plan, derived, position, [], { ...quote, buyValue: '1160', value: '1149' }, true)
      .observing,
    false,
  )
})
