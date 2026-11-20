import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sgeSessionLabel, sgeMinutePoints } from '../src/domain/sge-session'

test('上金所常规时段按北京时间区分日盘、收盘间隙、夜盘和周末', () => {
  for (const [stamp, label] of [
    ['2026-11-20T08:59:00+08:00', '日盘待开 · 09:00 开盘'],
    ['2026-11-20T09:00:00+08:00', '日盘时段 · 延时行情'],
    ['2026-11-20T15:29:00+08:00', '日盘时段 · 延时行情'],
    ['2026-11-20T15:30:00+08:00', '日盘已收盘 · 20:00 开盘'],
    ['2026-11-20T19:59:00+08:00', '日盘已收盘 · 20:00 开盘'],
    ['2026-11-20T20:00:00+08:00', '夜盘时段 · 延时行情'],
    ['2026-11-21T02:29:00+08:00', '夜盘时段 · 延时行情'],
    ['2026-11-21T02:30:00+08:00', '周末休市'],
    ['2026-11-22T20:00:00+08:00', '周末休市'],
    ['2026-11-23T01:00:00+08:00', '日盘待开 · 09:00 开盘'],
  ])
    assert.equal(sgeSessionLabel(new Date(stamp)), label, stamp)
})

test('日盘保留前夜完整曲线，跨午夜不闪空，过期缓存仍隐藏且不补点', () => {
  const points = [
    { date: '2026-11-19 20:00', value: '801' },
    { date: '2026-11-19 23:59', value: '802' },
    { date: '2026-11-20 02:30', value: '803' },
    { date: '2026-11-20 15:30', value: '804' },
  ]
  assert.equal(sgeMinutePoints(points, new Date('2026-11-20T17:00:00+08:00')), points)
  const night = points.slice(0, 2)
  assert.equal(sgeMinutePoints(night, new Date('2026-11-20T00:00:00+08:00')), night)
  assert.deepEqual(sgeMinutePoints(points, new Date('2026-11-21T17:00:00+08:00')), [])
  assert.deepEqual(sgeMinutePoints([], new Date('2026-11-20T17:00:00+08:00')), [])
})
