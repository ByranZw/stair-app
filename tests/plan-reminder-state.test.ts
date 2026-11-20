import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBook } from '../src/domain/book'
import { appVisible } from '../src/state/app-visibility'
import { bookState } from '../src/state/book'
import { watchState } from '../src/state/watchlist'

test('刷新到达的报价不会因展示时钟落后一拍而短暂误报历史待核验', async () => {
  appVisible.value = false
  const originalNow = Date.now
  const originalBook = bookState.data
  const id = 'GOLD:CMB-GOLD'
  const before = watchState.cache[id]
  let now = Date.parse('2026-11-20T02:00:00Z')
  Date.now = () => now
  try {
    const { allPlanReminders } = await import('../src/state/plan-reminders')
    now += 5000
    const date = '2026-11-20 10:00:05'
    const book = emptyBook()
    book.accounts = [{ id: 'a', name: '测试账户', openingCash: '20000', date: '2026-11-19' }]
    book.instruments = [{ id, code: 'CMB-GOLD', name: '招行黄金账户', type: 'GOLD' }]
    book.plans = [
      {
        id: 'p',
        accountId: 'a',
        instrumentId: id,
        budget: '10000',
        parts: 10,
        drop: '4',
        observe: '15',
        retrace: '4',
        version: 1,
        createdAt: '2026-11-19T00:00:00Z',
        initialLastBuy: '1000',
        paused: false,
        observing: false,
        signal: 'buy',
        signalDate: date,
        lastQuoteDate: date,
      },
    ]
    bookState.data = book
    watchState.cache[id] = {
      quote: {
        instrumentId: id,
        value: '760',
        buyValue: '765',
        date,
        fetchedAt: new Date(now).toISOString(),
        source: '招商银行',
        kind: 'market',
        tradable: true,
      },
      history: {
        instrumentId: id,
        points: [],
        fetchedAt: new Date(now).toISOString(),
        source: '上金所 Au99.99',
      },
    }
    assert.equal(allPlanReminders.value[0].kind, 'buy')
    assert.equal(allPlanReminders.value[0].actionable, true)
  } finally {
    Date.now = originalNow
    bookState.data = originalBook
    if (before) watchState.cache[id] = before
    else delete watchState.cache[id]
  }
})
