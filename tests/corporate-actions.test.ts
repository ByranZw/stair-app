import test from 'node:test'
import assert from 'node:assert/strict'
import 'fake-indexeddb/auto'
import { emptyBook } from '../src/domain/book'
import type { Book, CorporateAction, Plan } from '../src/domain/book'
import { projectBook, recordCorporateAction, recordTrade } from '../src/domain/ledger'
import { evaluatePlan } from '../src/domain/strategy'
import { createBackup, readBackup } from '../src/domain/backup'
import { openIndexedBook } from '../src/storage/indexed-book'

/** 固定一笔买入作为权益基准，核对分红和拆分不改变历史费用及成本。 */
function fixture(): Book {
  const b = emptyBook()
  b.accounts = [{ id: 'a', name: '权益测试', openingCash: '50000', date: '2026-01-01' }]
  b.instruments = [{ id: 'ETF:510300', code: '510300', name: '测试ETF', type: 'ETF', market: 'sh' }]
  b.plans = [
    {
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
    },
  ]
  return recordTrade(b, {
    id: 't1',
    accountId: 'a',
    instrumentId: 'ETF:510300',
    planId: 'p',
    date: '2026-01-02',
    time: '10:00',
    side: 'buy',
    status: 'confirmed',
    qty: '100',
    price: '10',
    fee: '1',
    sequence: 1,
    orderConfirmed: false,
    pendingAmount: '',
  })
}
/** 明确公告每份金额与实际到账，拆分和再投可覆盖各自确认字段。 */
function action(extra: Partial<CorporateAction> = {}): CorporateAction {
  return {
    id: 'action',
    accountId: 'a',
    instrumentId: 'ETF:510300',
    date: '2026-01-03',
    type: 'dividend',
    status: 'confirmed',
    referenceQty: '100',
    cashPerShare: '0.2',
    cashAmount: '18',
    ratio: '',
    addedQty: '',
    source: '测试公告及权益确认',
    orderConfirmed: true,
    ...extra,
  }
}

test('现金分红只加实际到账与已实现收益，不冲减持仓历史成本，参考买点除息调整', () => {
  const b = recordCorporateAction(fixture(), action())
  const p = projectBook(b),
    pos = p.positions['a/ETF:510300']
  assert.equal(p.cash.a, '49017.00')
  assert.equal(pos.qty, '100')
  assert.equal(pos.totalCost, '1001')
  assert.equal(pos.realizedPnl, '18')
  assert.equal(p.plans.p.lastBuy, '9.8')
  assert.equal(p.plans.p.used, '1001.00')
  assert.equal(b.plans[0].paused, true)
  assert.equal(b.plans[0].history![1].kind, 'corporate-action')
  const sold = recordTrade(b, {
    id: 't2',
    accountId: 'a',
    instrumentId: 'ETF:510300',
    planId: 'p',
    date: '2026-01-04',
    time: '10:00',
    side: 'sell',
    status: 'confirmed',
    qty: '100',
    price: '10',
    fee: '1',
    sequence: 2,
    orderConfirmed: false,
    pendingAmount: '',
  })
  assert.equal(projectBook(sold).trades.t2.realizedPnl, '-2')
  assert.equal(projectBook(sold).positions['a/ETF:510300'].realizedPnl, '16')
})

test('份额拆分保持现金总成本与预算，按新份额计算单位成本和卖出结转', () => {
  let b = recordCorporateAction(fixture(), action({ type: 'split', ratio: '2' }))
  let p = projectBook(b)
  assert.equal(p.cash.a, '48999.00')
  assert.equal(p.positions['a/ETF:510300'].qty, '200')
  assert.equal(p.positions['a/ETF:510300'].unitCost, '5.005')
  assert.equal(p.plans.p.lastBuy, '5')
  b = recordTrade(b, {
    id: 't2',
    accountId: 'a',
    instrumentId: 'ETF:510300',
    planId: 'p',
    date: '2026-01-04',
    time: '10:00',
    side: 'sell',
    status: 'confirmed',
    qty: '100',
    price: '6',
    fee: '1',
    sequence: 2,
    orderConfirmed: false,
    pendingAmount: '',
  })
  p = projectBook(b)
  assert.equal(p.trades.t2.costBasis, '500.5')
  assert.equal(p.trades.t2.realizedPnl, '98.5')
})

test('红利再投不增减现金、不占追加预算，新增确认份额与对应成本，保留分红收益', () => {
  const b = recordCorporateAction(
    fixture(),
    action({ type: 'reinvest', cashAmount: '20', addedQty: '2' }),
  )
  const p = projectBook(b)
  assert.equal(p.cash.a, '48999.00')
  assert.equal(p.positions['a/ETF:510300'].qty, '102')
  assert.equal(p.positions['a/ETF:510300'].totalCost, '1021')
  assert.equal(p.positions['a/ETF:510300'].realizedPnl, '20')
  assert.equal(p.plans.p.used, '1001.00')
})

test('待核对只暂停不入账，手动恢复也不能绕过事件阻断，确认幂等并释放事件阻断', () => {
  const before = fixture(),
    pending = action({
      status: 'pending',
      referenceQty: '',
      cashPerShare: '',
      cashAmount: '',
      orderConfirmed: false,
    })
  const b = recordCorporateAction(before, pending),
    p = projectBook(b)
  assert.equal(p.cash.a, projectBook(before).cash.a)
  assert.equal(p.plans.p.eventBlocked, true)
  const plan: Plan = { ...b.plans[0], paused: false }
  const next = evaluatePlan(
    plan,
    p.plans.p,
    p.positions['a/ETF:510300'],
    b.trades,
    {
      instrumentId: plan.instrumentId,
      value: '8',
      date: '2026-01-04',
      source: '测试',
      fetchedAt: '2026-01-04T00:00:00Z',
      kind: 'market',
    },
    true,
  )
  assert.equal(next.signal, undefined)
  assert.equal(recordCorporateAction(b, pending), b)
  const confirmed = recordCorporateAction(b, action())
  assert.equal(projectBook(confirmed).plans.p.eventBlocked, false)
  assert.equal(recordCorporateAction(confirmed, action()), confirmed)
  assert.throws(() => recordCorporateAction(confirmed, action({ cashAmount: '19' })), /已确认/)
})

test('权益份额、金额、日期、重复事件和日初顺序不符均拒绝；失败不污染原账本', () => {
  const b = fixture(),
    original = JSON.stringify(b)
  for (const bad of [
    action({ referenceQty: '99' }),
    action({ cashAmount: '21' }),
    action({ date: '2026-01-01' }),
    action({ orderConfirmed: false }),
    action({ type: 'split', ratio: '0' }),
  ])
    assert.throws(() => recordCorporateAction(b, bad))
  assert.equal(JSON.stringify(b), original)
  const next = recordCorporateAction(b, action())
  assert.throws(() => recordCorporateAction(next, action({ id: 'duplicate' })), /同日只登记/)
})

test('事件随JSON备份及IndexedDB事务往返；旧v2数据库只加事件表不丢资金', async () => {
  const b = recordCorporateAction(fixture(), action())
  assert.deepEqual(readBackup(createBackup(b)).book, b)
  const name = 'events-' + Date.now()
  // 精确模拟事件功能前的v2表结构，不从新entityTables反向生成伪旧库。
  await new Promise<void>((resolve, reject) => {
    const r = indexedDB.open(name, 2)
    r.onupgradeneeded = () => {
      const db = r.result
      db.createObjectStore('meta', { keyPath: 'id' }).put({ id: 'state', schema: 1, revision: 0 })
      for (const t of [
        'accounts',
        'instruments',
        'openings',
        'trades',
        'cashFlows',
        'plans',
        'positions',
        'recovery',
      ])
        db.createObjectStore(t, { keyPath: 'id' })
    }
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      r.result.close()
      resolve()
    }
  })
  const db = await openIndexedBook(name)
  b.revision = 1
  await db.save(b, projectBook(b), 0)
  const loaded = await db.load()
  assert.deepEqual(loaded, b)
  assert.equal(projectBook(loaded).cash.a, '49017.00')
  await db.close()
})

test('除息与到账分开重放：到账前不增加可用现金或再投份额，旧事件缺到账日保持原口径', () => {
  const dividend = recordCorporateAction(fixture(), action({ cashDate: '2026-01-10' }))
  const early = projectBook(dividend, '2026-01-05')
  assert.equal(early.cash.a, '48999.00')
  assert.equal(early.positions['a/ETF:510300'].realizedPnl, '0.00')
  assert.equal(early.plans.p.lastBuy, '9.8')
  assert.equal(projectBook(dividend).cash.a, '49017.00')
  const reinvest = recordCorporateAction(
    fixture(),
    action({
      type: 'reinvest',
      cashDate: '2026-01-10',
      addedQty: '2',
    }),
  )
  assert.equal(projectBook(reinvest, '2026-01-05').positions['a/ETF:510300'].qty, '100')
  assert.equal(projectBook(reinvest).positions['a/ETF:510300'].qty, '102')
  assert.equal(projectBook(reinvest).positions['a/ETF:510300'].totalCost, '1019')
  assert.throws(
    () => recordCorporateAction(fixture(), action({ cashDate: '2026-01-01' })),
    /不能早于/,
  )
  assert.equal(projectBook(recordCorporateAction(fixture(), action())).cash.a, '49017.00')
})
