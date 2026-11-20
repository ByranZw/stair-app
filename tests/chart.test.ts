import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  aggregateCandles,
  chartReferences,
  mergeHistory,
  startsHistorySegment,
} from '../src/domain/chart'
import { emptyBook, type Plan, type Trade } from '../src/domain/book'
import { appendPlanEvent } from '../src/domain/plan-history'
import { parseMinute } from '../src/services/parsers'
import type { History, Instrument } from '../src/domain/market'

const etf: Instrument = {
  id: 'ETF:510300',
  code: '510300',
  name: '沪深300ETF',
  type: 'ETF',
  market: 'sh',
}

test('真实分钟样本按来源日期/时刻解析，拒绝错代码与重复时刻', () => {
  const raw = JSON.parse(
    readFileSync(new URL('./fixtures/etf-minute.json', import.meta.url), 'utf8'),
  )
  const result = parseMinute(raw, etf)
  assert.equal(result.points[0].date, '2026-11-19 09:30')
  assert.equal(result.points[0].value, '4.046')
  assert.equal(result.resolution, 'minute')
  raw.data.sh510300.data.data.push(raw.data.sh510300.data.data[0])
  assert.throws(() => parseMinute(raw, etf), /重复/)
  raw.data.sh510300.qt.sh510300[2] = '510500'
  assert.throws(() => parseMinute(raw, etf), /代码不一致/)
})

test('增量覆盖保留旧日期、替换来源修订点，不重复累计', () => {
  const initial: History = {
    instrumentId: etf.id,
    source: 'test',
    fetchedAt: '2026-11-19',
    points: [
      { date: '2026-11-17', value: '3.8' },
      { date: '2026-11-18', value: '4' },
    ],
  }
  const next = {
    ...initial,
    points: [
      { date: '2026-11-18', value: '4.01' },
      { date: '2026-11-19', value: '4.02' },
    ],
  }
  const merged = mergeHistory(initial, next)
  assert.deepEqual(
    merged.points.map((p) => p.value),
    ['3.8', '4.01', '4.02'],
  )
  assert.deepEqual(mergeHistory(merged, next), merged)
  assert.equal(initial.points[1].value, '4')
})

test('周月K正确取首开末收/最高最低/成交量，缺少OHLC不能伪造', () => {
  const points = [
    { date: '2026-10-30', open: '10', value: '11', high: '12', low: '9', volume: '100' },
    { date: '2026-11-02', open: '11', value: '12', high: '13', low: '10', volume: '200' },
    { date: '2026-11-03', open: '12', value: '10', high: '14', low: '8', volume: '300' },
  ]
  const weekly = aggregateCandles(points, 'week')
  assert.equal(weekly.length, 2)
  assert.deepEqual(weekly[1], {
    date: '2026-11-03',
    startDate: '2026-11-02',
    open: '11',
    value: '10',
    high: '14',
    low: '8',
    volume: '500',
  })
  assert.equal(aggregateCandles(points, 'month')[1].volume, '500')
  assert.throws(() => aggregateCandles([{ date: '2026-11-02', value: '12' }], 'week'), /缺少日K/)
})

test('历史成本随买入和拆分变化，买点采用对应参数版本，暂停后不画生效策略线', () => {
  const book = emptyBook()
  book.accounts.push({ id: 'a', name: '账户', openingCash: '50000', date: '2026-11-01' })
  book.instruments.push(etf)
  const plan: Plan = {
    id: 'p',
    accountId: 'a',
    instrumentId: etf.id,
    budget: '50000',
    parts: 10,
    drop: '4',
    observe: '15',
    retrace: '4',
    version: 1,
    createdAt: '2026-11-01T01:00:00Z',
    paused: false,
    observing: false,
  }
  appendPlanEvent(plan, { kind: 'created', reason: '创建' }, '2026-11-01T01:00:00Z')
  plan.drop = '10'
  plan.version = 2
  appendPlanEvent(plan, { kind: 'parameters', reason: '改为10%' }, '2026-11-03T01:00:00Z')
  plan.paused = true
  appendPlanEvent(plan, { kind: 'paused', reason: '暂停' }, '2026-11-06T01:00:00Z')
  book.plans.push(plan)
  const buy: Trade = {
    id: 't1',
    accountId: 'a',
    instrumentId: etf.id,
    planId: 'p',
    side: 'buy',
    status: 'confirmed',
    date: '2026-11-02',
    time: '10:00',
    sequence: 1,
    orderConfirmed: true,
    qty: '100',
    price: '10',
    fee: '1',
    pendingAmount: '0',
  }
  book.trades.push(buy, {
    ...buy,
    id: 't2',
    date: '2026-11-04',
    sequence: 2,
    qty: '100',
    price: '8',
  })
  book.corporateActions!.push({
    id: 's',
    accountId: 'a',
    instrumentId: etf.id,
    date: '2026-11-05',
    type: 'split',
    status: 'confirmed',
    referenceQty: '200',
    ratio: '2',
    cashPerShare: '',
    cashAmount: '',
    addedQty: '',
    source: '已核对公告',
    orderConfirmed: true,
  })
  const rows = chartReferences(
    book,
    'a',
    etf.id,
    ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'],
    plan,
  )
  assert.equal(rows[0].cost, undefined)
  assert.equal(rows[1].cost, '10.01')
  assert.equal(rows[1].buy, '9.6')
  assert.equal(rows[2].buy, '9')
  assert.equal(rows[3].cost, '9.01')
  assert.equal(rows[3].buy, '7.2')
  assert.equal(rows[4].cost, '4.505')
  assert.equal(rows[4].buy, '3.6')
  assert.equal(rows[5].buy, undefined)
  assert.equal(rows[5].sell, undefined)
})

test('黄金本机采样跨缺失日断线，真实ETF休市日期不被误判为采样缺口', () => {
  const points = [
    { date: '2026-01-01', value: '800', sampledAt: '2026-01-01 12:00:00' },
    { date: '2026-01-02', value: '801', sampledAt: '2026-01-02 12:00:00' },
    { date: '2026-01-06', value: '805', sampledAt: '2026-01-06 12:00:00' },
  ]
  assert.equal(startsHistorySegment(points, 0), true)
  assert.equal(startsHistorySegment(points, 1), false)
  assert.equal(startsHistorySegment(points, 2), true)
  assert.equal(
    startsHistorySegment(
      points.map(({ date, value }) => ({ date, value })),
      2,
    ),
    false,
  )
})

test('积存金分时按当日账户流水和计划快照画参考线，不从市场曲线推算策略价', () => {
  const book = emptyBook()
  const gold: Instrument = {
    id: 'GOLD:CMB-GOLD',
    code: 'CMB-GOLD',
    name: '招行黄金账户',
    type: 'GOLD',
  }
  book.accounts.push({ id: 'a', name: '招行', openingCash: '50000', date: '2026-11-01' })
  book.accounts.push({
    id: 'other-account',
    name: '其他账户',
    openingCash: '0',
    date: '2026-11-01',
  })
  book.instruments.push(gold)
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
    observing: true,
    high: '950',
  }
  appendPlanEvent(plan, { kind: 'created', reason: '创建' }, plan.createdAt)
  book.plans.push(plan)
  book.trades.push({
    id: 'gold-buy',
    accountId: 'a',
    instrumentId: gold.id,
    planId: plan.id,
    side: 'buy',
    status: 'confirmed',
    date: '2026-11-02',
    time: '10:00',
    sequence: 1,
    orderConfirmed: true,
    qty: '2',
    price: '800',
    fee: '2',
    pendingAmount: '0',
  })
  book.openings.push({
    id: 'other',
    accountId: 'other-account',
    instrumentId: gold.id,
    date: '2026-11-01',
    qty: '5',
    totalCost: '4500',
  })
  const minute = chartReferences(book, 'a', gold.id, ['2026-11-03 09:31', '2026-11-03 14:59'], plan)
  assert.deepEqual(minute, [{ date: '2026-11-03', cost: '801', buy: '768', sell: '912' }])
  assert.deepEqual(chartReferences(book, 'a', gold.id, ['2026-11-03'], plan), minute)
})
