import test from 'node:test'
import assert from 'node:assert/strict'
import { goldToday, goldMinuteHistory, goldSampleChanges } from '../src/domain/gold-history'
import { startsHistorySegment } from '../src/domain/chart'
import type { Quote } from '../src/domain/market'

/** 测试固定北京时间，避免机器当前时区影响采样所属日期。 */
function quote(date: string, value = '800', tradable = true): Quote {
  return {
    instrumentId: 'GOLD:CMB-GOLD',
    value,
    buyValue: '805',
    date,
    fetchedAt: '2026-11-19T03:00:00Z',
    source: '招行',
    kind: 'market',
    tradable,
  }
}
const now = new Date('2026-11-19T03:00:00Z')
test('Android旧逻辑层缺少Array.at时仍可保存真实分钟采样', () => {
  const original = Object.getOwnPropertyDescriptor(Array.prototype, 'at')!
  try {
    Object.defineProperty(Array.prototype, 'at', { ...original, value: undefined })
    const history = goldMinuteHistory(undefined, quote('2026-11-19 10:00:30'), now)
    assert.equal(history.points.length, 1)
    assert.equal(history.points[0].sampledAt, '2026-11-19 10:00:30')
  } finally {
    Object.defineProperty(Array.prototype, 'at', original)
  }
})
test('黄金分钟同一分钟保留较新来源秒，双侧完整且倒序及重复不回退', () => {
  let history = goldMinuteHistory(undefined, quote('2026-11-19 10:00:30'), now)
  history = goldMinuteHistory(history, quote('2026-11-19 10:00:40', '801'), now)
  assert.equal(history.points.length, 1)
  assert.equal(history.points[0].value, '801')
  assert.equal(history.points[0].buyValue, '805')
  assert.equal(history.points[0].sampledAt, '2026-11-19 10:00:40')
  for (const date of ['2026-11-19 09:59:59', '2026-11-19 10:00:40']) {
    assert.deepEqual(goldMinuteHistory(history, quote(date, '100'), now).points, history.points)
  }
})
test('中国日期跨日淘汰旧分钟，旧报价与非交易不形成今日点', () => {
  assert.equal(goldToday(new Date('2026-11-18T16:00:00Z')), '2026-11-19')
  const old = goldMinuteHistory(
    undefined,
    quote('2026-11-18 23:59:00'),
    new Date('2026-11-18T15:59:00Z'),
  )
  assert.equal(goldMinuteHistory(old, quote('2026-11-18 23:59:00'), now).points.length, 0)
  assert.equal(
    goldMinuteHistory(old, quote('2026-11-19 10:00:00', '800', false), now).points.length,
    0,
  )
  assert.equal(goldMinuteHistory(old, quote('2026-11-19 10:00:00'), now).points.length, 1)
})
test('前台采样分钟缺口超过两分钟断线，连续点和日采样规则保持', () => {
  const points = ['10:00', '10:01', '10:04'].map((time) => ({
    date: '2026-11-19 ' + time,
    value: '800',
    sampledAt: '2026-11-19 ' + time + ':00',
  }))
  assert.equal(startsHistorySegment(points, 1), false)
  assert.equal(startsHistorySegment(points, 2), true)
  const daily = ['2026-11-17', '2026-11-18', '2026-11-20'].map((date) => ({
    date,
    value: '800',
    sampledAt: date + ' 15:00:00',
  }))
  assert.equal(startsHistorySegment(daily, 1), false)
  assert.equal(startsHistorySegment(daily, 2), true)
})
test('采样变化包含之前区间基准和跨日间隔，首条及零基准不造百分比', () => {
  const result = goldSampleChanges([
    { date: '2026-10-31', value: '800' },
    { date: '2026-11-02', value: '808' },
  ])
  assert.equal(result[0].changePercent, undefined)
  assert.equal(result[1].previousDate, '2026-10-31')
  assert.equal(result[1].gapDays, 2)
  assert.equal(result[1].changeAmount, '8.00')
  assert.equal(result[1].changePercent, '1.00')
  assert.equal(
    goldSampleChanges([
      { date: '2026-11-01', value: '0' },
      { date: '2026-11-02', value: '1' },
    ])[1].changePercent,
    undefined,
  )
})
