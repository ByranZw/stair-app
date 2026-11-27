import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { emptyBook, positionKey } from '../src/domain/book'
import type { Book, Trade, Plan } from '../src/domain/book'
import { projectBook, recordTrade } from '../src/domain/ledger'
import { D } from '../src/domain/money'
import { evaluatePlan } from '../src/domain/strategy'
import { openIndexedBook } from '../src/storage/indexed-book'

/** 独立测试账本从真实现金基准开始，固定历史日不依赖当前行情。 */
function fixture(): Book {
  const book = emptyBook()
  book.accounts = [{ id: 'a', name: '测试账户', openingCash: '50000', date: '2026-01-01' }]
  book.instruments = [
    { id: 'ETF:510300', code: '510300', name: '测试ETF', type: 'ETF', market: 'sh' },
  ]
  return book
}
/** 每笔固定时间便于验证补录与历史成本；调用方可明确覆盖状态和归属。 */
function trade(
  id: string,
  date: string,
  side: 'buy' | 'sell',
  qty: string,
  price: string,
  fee = '0',
  extra: Partial<Trade> = {},
): Trade {
  return {
    id,
    accountId: 'a',
    instrumentId: 'ETF:510300',
    side,
    status: 'confirmed',
    date,
    time: '10:00',
    sequence: Number(id.replace(/\D/g, '')) || 1,
    orderConfirmed: false,
    qty,
    price,
    fee,
    pendingAmount: '',
    ...extra,
  }
}
/** 默认计划与UI同源参数，用于边界触发测试。 */
function plan(): Plan {
  return {
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
}

test('卖出按当时加权成本计算，部分卖出不改变单位成本，后续买入不覆盖历史盈利', () => {
  let b = fixture()
  b = recordTrade(b, trade('t1', '2026-01-02', 'buy', '1000', '10', '10'))
  b = recordTrade(b, trade('t2', '2026-01-03', 'buy', '1000', '8.6', '7.5'))
  const before = projectBook(b).positions[positionKey('a', 'ETF:510300')].unitCost
  b = recordTrade(b, trade('t3', '2026-01-04', 'sell', '800', '10.25', '5'))
  let result = projectBook(b)
  assert.equal(result.trades.t3.costBasis, '7447')
  assert.equal(result.trades.t3.realizedPnl, '748')
  assert.equal(result.positions[positionKey('a', 'ETF:510300')].unitCost, before)
  b = recordTrade(b, trade('t4', '2026-01-05', 'buy', '100', '15'))
  result = projectBook(b)
  assert.equal(result.trades.t3.realizedPnl, '748')
})
test('分摊小数不逐笔丢失成本，清仓后成本归零且现金与累计盈利守恒', () => {
  let b = fixture()
  b = recordTrade(b, trade('t1', '2026-01-02', 'buy', '3', '0.01', '0.01'))
  for (let i = 0; i < 3; i++)
    b = recordTrade(b, trade('s' + (i + 2), `2026-01-0${i + 3}`, 'sell', '1', '0.02'))
  const p = projectBook(b)
  assert.equal(p.positions['a/ETF:510300'].totalCost, '0')
  assert.equal(p.cash.a, '50000.02')
  assert(new D(p.positions['a/ETF:510300'].realizedPnl).minus('.02').abs().lt('0.000000001'))
})
test('补录早期卖出不能借用后来买入份额；同日缺少时间必须确认顺序', () => {
  let b = recordTrade(fixture(), trade('t1', '2026-01-03', 'buy', '100', '10'))
  assert.throws(() => recordTrade(b, trade('t2', '2026-01-02', 'sell', '1', '11')), /当时持仓/)
  b = recordTrade(b, trade('t2', '2026-01-04', 'buy', '1', '10', '0', { time: '' }))
  assert.throws(
    () => recordTrade(b, trade('t3', '2026-01-04', 'sell', '1', '11')),
    /确认按记录顺序/,
  )
  b = recordTrade(b, trade('t3', '2026-01-04', 'sell', '1', '11'), true)
  assert.equal(b.trades.filter((t) => t.date === '2026-01-04' && t.orderConfirmed).length, 2)
})
test('导入不扣现金、不生成买点；不同账户不共享成本和份额', () => {
  const b = fixture()
  b.accounts.push({ id: 'b', name: '另一个账户', openingCash: '0', date: '2026-01-01' })
  b.openings.push({
    id: 'o',
    accountId: 'a',
    instrumentId: 'ETF:510300',
    date: '2026-01-02',
    qty: '100',
    totalCost: '900',
  })
  b.plans.push(plan())
  const p = projectBook(b)
  assert.equal(p.cash.a, '50000.00')
  assert.equal(p.plans.p.lastBuy, undefined)
  assert.throws(
    () => recordTrade(b, trade('t1', '2026-01-03', 'sell', '1', '10', '0', { accountId: 'b' })),
    /当时持仓/,
  )
})
test('场外申请仅预留，正式确认原子替换，撤销释放，不会重复生成成交', () => {
  let b = fixture()
  b.instruments = [{ id: 'FUND:110022', code: '110022', name: '测试基金', type: 'FUND' }]
  const pending = trade('t1', '2026-01-02', 'buy', '', '', '2', {
    instrumentId: 'FUND:110022',
    status: 'pending',
    pendingAmount: '1000',
  })
  b = recordTrade(b, pending)
  let p = projectBook(b)
  assert.equal(p.cash.a, '50000.00')
  assert.equal(p.availableCash.a, '48998.00')
  assert.deepEqual(p.positions, {})
  assert.equal(recordTrade(b, pending), b)
  const confirmed = {
    ...pending,
    status: 'confirmed' as const,
    date: '2026-01-03',
    qty: '500',
    price: '2',
  }
  b = recordTrade(b, confirmed, false, 't1')
  p = projectBook(b)
  assert.equal(b.trades.length, 1)
  assert.equal(b.trades[0].applicationDate, '2026-01-02')
  assert.equal(p.cash.a, '48998.00')
  assert.equal(p.positions['a/FUND:110022'].qty, '500')
  assert.throws(() => recordTrade(b, confirmed, false, 't1'), /已处理/)
  b = recordTrade(b, { ...pending, id: 't2' })
  b.trades.find((t) => t.id === 't2')!.status = 'cancelled'
  assert.equal(projectBook(b).availableCash.a, '48998.00')
})
test('待确认赎回不能与后续卖出重复占用持仓', () => {
  let b = fixture()
  b.instruments = [{ id: 'FUND:110022', code: '110022', name: '测试基金', type: 'FUND' }]
  b = recordTrade(
    b,
    trade('t1', '2026-01-02', 'buy', '100', '1', '0', { instrumentId: 'FUND:110022' }),
  )
  b = recordTrade(
    b,
    trade('t2', '2026-01-03', 'sell', '80', '', '0', {
      instrumentId: 'FUND:110022',
      status: 'pending',
    }),
  )
  assert.throws(
    () =>
      recordTrade(
        b,
        trade('t3', '2026-01-04', 'sell', '30', '1', '0', { instrumentId: 'FUND:110022' }),
      ),
    /超过可用份额/,
  )
})
test('黄金元克转换按实际克重记账，不以近似换算值制造份额', () => {
  let b = fixture()
  b.instruments = [{ id: 'GOLD:CMB-GOLD', code: 'CMB-GOLD', name: '招行积存金', type: 'GOLD' }]
  b = recordTrade(
    b,
    trade('t1', '2026-01-02', 'buy', '1.234567', '600', '1', {
      instrumentId: 'GOLD:CMB-GOLD',
      inputAmount: '740.74',
    }),
  )
  const p = projectBook(b)
  assert.equal(p.positions['a/GOLD:CMB-GOLD'].qty, '1.234567')
  assert.equal(p.cash.a, '49258.26')
  assert.throws(
    () =>
      recordTrade(
        b,
        trade('t2', '2026-01-03', 'buy', '1', '600', '0', {
          instrumentId: 'GOLD:CMB-GOLD',
          inputAmount: '601',
        }),
      ),
    /不一致/,
  )
})
test('跨多档只发一份提醒；实际成交更新基准；观察高点回撤触发卖出并保持待执行', () => {
  const p = plan(),
    result = { id: 'p', used: '5000', reserved: '0', lastBuy: '10', ended: false }
  const quote = {
    instrumentId: p.instrumentId,
    value: '8',
    date: '2026-02-02T10:00:00',
    source: 'test',
    fetchedAt: '2026-02-02T10:00:00Z',
    kind: 'market' as const,
  }
  let next = evaluatePlan(p, result, undefined, [], quote, true)
  assert.equal(next.signal, 'buy')
  assert.equal(result.used, '5000')
  assert.equal(evaluatePlan(p, result, undefined, [], quote, false).signal, undefined)
  const position = {
    accountId: 'a',
    instrumentId: p.instrumentId,
    qty: '100',
    totalCost: '1000',
    unitCost: '10',
    realizedPnl: '0',
  }
  next = evaluatePlan(p, result, position, [], { ...quote, value: '12' }, true)
  assert.equal(next.high, '12')
  assert.equal(next.observing, true)
  next = evaluatePlan(
    next,
    result,
    position,
    [],
    { ...quote, value: '11.52', date: '2026-02-02T11:00:00' },
    true,
  )
  assert.equal(next.signal, 'sell')
  next = evaluatePlan(
    next,
    result,
    position,
    [],
    { ...quote, value: '13', date: '2026-02-02T12:00:00' },
    true,
  )
  assert.equal(next.signal, 'sell')
  assert.equal(
    evaluatePlan(p, result, position, [], { ...quote, corporateAction: true }, true).signal,
    undefined,
  )
})
test('IndexedDB事务同时保存原始账本和投影，重启恢复；并发旧版本拒绝且不损坏原数据', async () => {
  const db = await openIndexedBook('test-' + Date.now())
  const b = fixture()
  b.revision = 1
  await db.save(b, projectBook(b), 0)
  const stale = { ...b, revision: 2 }
  const fresh = recordTrade(stale, trade('t1', '2026-01-02', 'buy', '100', '10'))
  await db.save(fresh, projectBook(fresh), 1)
  await assert.rejects(db.save(stale, projectBook(stale), 1), /其他页面修改/)
  const restored = await db.load()
  assert.equal(restored.trades.length, 1)
  assert.equal(restored.revision, 2)
  assert.equal(projectBook(restored).cash.a, '49000.00')
  await db.close()
})

test('事务写入中途序列化失败整体回滚，绝不留下清空的账户或半份交易', async () => {
  const db = await openIndexedBook('rollback-' + Date.now())
  const b = fixture()
  b.revision = 1
  await db.save(b, projectBook(b), 0)
  const bad = fixture()
  bad.revision = 2
  Object.assign(bad.accounts[0], { unserializable: () => undefined })
  await assert.rejects(db.save(bad, projectBook(bad), 1), /事务已回滚/)
  const restored = await db.load()
  assert.equal(restored.revision, 1)
  assert.equal(restored.accounts[0].name, '测试账户')
  assert.equal(restored.accounts.length, 1)
  await db.close()
})
test('本轮累计买入不因部分卖出而回填预算，清仓后只能新开下一轮', () => {
  let b = fixture()
  b.plans = [plan()]
  b = recordTrade(b, trade('t1', '2026-01-02', 'buy', '100', '10', '1', { planId: 'p' }))
  b = recordTrade(b, trade('t2', '2026-01-03', 'sell', '50', '11', '1', { planId: 'p' }))
  assert.equal(projectBook(b).plans.p.used, '1001.00')
  assert.equal(projectBook(b).plans.p.ended, false)
  b = recordTrade(b, trade('t3', '2026-01-04', 'sell', '50', '11', '1', { planId: 'p' }))
  assert.equal(projectBook(b).plans.p.ended, true)
  assert.throws(
    () => recordTrade(b, trade('t4', '2026-01-05', 'buy', '1', '10', '0', { planId: 'p' })),
    /本轮计划已结束/,
  )
})

test('复现已批准Demo的两买一卖：单位成本3.7215、卖出净盈利752元', () => {
  let b = fixture()
  b = recordTrade(b, trade('t1', '2026-01-02', 'buy', '5000', '3.8', '7.5'))
  b = recordTrade(b, trade('t2', '2026-01-03', 'buy', '5000', '3.64', '7.5'))
  b = recordTrade(b, trade('t3', '2026-01-04', 'sell', '2000', '4.1', '5'))
  const p = projectBook(b)
  assert.equal(p.positions['a/ETF:510300'].unitCost, '3.7215')
  assert.equal(p.trades.t3.costBasis, '7443')
  assert.equal(p.trades.t3.net, '8195.00')
  assert.equal(p.trades.t3.realizedPnl, '752')
})
