import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseSgeDaily, parseSgeMinute } from '../src/services/sge-history'
import type { Instrument } from '../src/domain/market'
const gold: Instrument = {
  id: 'GOLD:CMB-GOLD',
  code: 'CMB-GOLD',
  name: '招行黄金账户',
  type: 'GOLD',
}

test('上金所历史按官方开收低高顺序解析，不生成银行报价', () => {
  const history = parseSgeDaily({ time: [['2026-11-19', 810, 801.93, 793.44, 816]] }, gold)
  assert.deepEqual(history.points[0], {
    date: '2026-11-19',
    open: '810',
    value: '801.93',
    low: '793.44',
    high: '816',
  })
  assert.match(history.source, /市场参考/)
  assert.deepEqual(parseSgeDaily({ time: [['2026-11-19', 810, 801, 820, 816]] }, gold).points[0], {
    date: '2026-11-19',
    value: '801',
  })
  assert.deepEqual(parseSgeDaily({ time: [['2026-11-19', null, 801, 793, 816]] }, gold).points[0], {
    date: '2026-11-19',
    value: '801',
  })
  assert.throws(() => parseSgeDaily({ time: [['2026-11-19', 810, 0, 793, 816]] }, gold), /无效价格/)
  assert.throws(() => parseSgeDaily({ time: [] }, gold), /暂无/)
})
test('夜盘交易日可能次日，图表用真实日历日期，截止now丢弃未来预填值', () => {
  const history = parseSgeMinute(
    {
      heyue: 'Au99.99',
      times: ['20:00', '20:01', '20:02'],
      data: ['801', '802', '796'],
      now: '20:01',
      delaystr: '2026年11月20日 20:01:55',
    },
    gold,
    new Date('2026-11-19T20:02:00+08:00'),
  )
  assert.deepEqual(history.points, [
    { date: '2026-11-19 20:00', value: '801' },
    { date: '2026-11-19 20:01', value: '802' },
  ])
  assert.match(history.source, /交易日 2026-11-20/)
})
test('日盘跨午夜时间轴保留前一晚真实日期，不以交易日平移整条曲线', () => {
  const history = parseSgeMinute(
    {
      heyue: 'Au99.99',
      times: ['20:00', '23:59', '00:00', '09:01'],
      data: ['801', '802', '803', '804'],
      now: '09:01',
      delaystr: '2026年11月20日 09:01:55',
    },
    gold,
    new Date('2026-11-20T09:02:00+08:00'),
  )
  assert.equal(history.points[0].date, '2026-11-19 20:00')
  assert.equal(history.points[2].date, '2026-11-20 00:00')
})
test('旧交易日同刻及错配合约拒绝伪装为当日行情', () => {
  const raw = {
    heyue: 'Au99.99',
    times: ['09:01'],
    data: ['801'],
    now: '09:01',
    delaystr: '2026年11月19日 09:01:55',
  }
  assert.throws(() => parseSgeMinute(raw, gold, new Date('2026-11-20T09:02:00+08:00')), /交易日/)
  assert.throws(() => parseSgeMinute({ ...raw, heyue: 'Au(T+D)' }, gold), /格式/)
  assert.equal(parseSgeMinute(raw, gold, new Date('2026-11-19T19:02:00+08:00')).points.length, 1)
})

test('收盘后仍可查看当日日盘分时，昨日行情不能伪装成今天', () => {
  const raw = {
    heyue: 'Au99.99',
    times: ['20:00', '15:30'],
    data: ['801', '802'],
    now: '15:30',
    delaystr: '2026年11月19日 15:30:00',
  }
  assert.equal(
    parseSgeMinute(raw, gold, new Date('2026-11-19T19:00:00+08:00')).points[1].date,
    '2026-11-19 15:30',
  )
  assert.throws(() => parseSgeMinute(raw, gold, new Date('2026-11-20T19:00:00+08:00')), /交易日/)
})

test('周一交易日夜盘按上周五定位，周末旧夜盘不能平移成新行情', () => {
  const raw = {
    heyue: 'Au99.99',
    times: ['20:00', '20:30'],
    data: ['801', '802'],
    now: '20:30',
    delaystr: '2026年11月23日 20:30:55',
  }
  const friday = parseSgeMinute(raw, gold, new Date('2026-11-20T20:31:00+08:00'))
  assert.equal(friday.points[0].date, '2026-11-20 20:00')
  assert.throws(() => parseSgeMinute(raw, gold, new Date('2026-11-21T20:31:00+08:00')), /交易日/)
  assert.throws(() => parseSgeMinute(raw, gold, new Date('2026-11-22T20:31:00+08:00')), /交易日/)
})

test('周一日盘保留周五夜盘和周六凌晨真实日期', () => {
  const history = parseSgeMinute(
    {
      heyue: 'Au99.99',
      times: ['20:00', '00:30', '09:01'],
      data: ['801', '802', '803'],
      now: '09:01',
      delaystr: '2026年11月23日 09:01:55',
    },
    gold,
    new Date('2026-11-23T09:02:00+08:00'),
  )
  assert.deepEqual(
    history.points.map((p) => p.date),
    ['2026-11-20 20:00', '2026-11-21 00:30', '2026-11-23 09:01'],
  )
})

test('来源当前刻度与发布时间不同步时按较早时刻截断', () => {
  const history = parseSgeMinute(
    {
      heyue: 'Au99.99',
      times: ['20:43', '20:44', '20:45', '20:46'],
      data: ['800', '801', '802', '796'],
      now: '20:46',
      delaystr: '2026年11月20日 20:43:55',
    },
    gold,
    new Date('2026-11-19T20:47:00+08:00'),
  )
  assert.deepEqual(history.points, [{ date: '2026-11-19 20:43', value: '800' }])
})
