import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBook, type Trade } from '../src/domain/book'
import { bookState, selectedAccountId } from '../src/state/book'
import { portfolio } from '../src/state/portfolio'
import { watchState } from '../src/state/watchlist'

test('清仓收益持续汇总，账户筛选和现金流不改变收益口径', () => {
  const before = bookState.data
  const selected = selectedAccountId.value
  try {
    const book = emptyBook()
    book.accounts = [
      { id: 'a', name: '账户甲', openingCash: '2000', date: '2026-01-01' },
      { id: 'b', name: '账户乙', openingCash: '75000', date: '2026-01-01' },
    ]
    book.instruments = [
      { id: 'ETF:510300', code: '510300', name: 'ETF', type: 'ETF', market: 'sh' },
    ]
    book.trades = [
      { id: 'buy', side: 'buy', price: '4.2', date: '2026-01-02' },
      { id: 'sell', side: 'sell', price: '4.5', date: '2026-01-03' },
    ].map(
      (trade, index) =>
        ({
          ...trade,
          accountId: 'a',
          instrumentId: 'ETF:510300',
          status: 'confirmed',
          qty: '100',
          fee: '3',
          time: '',
          orderConfirmed: true,
          sequence: index + 1,
          pendingAmount: '',
        }) as Trade,
    )
    bookState.data = book
    selectedAccountId.value = ''
    assert.equal(portfolio.value.rows.length, 0)
    assert.equal(portfolio.value.realized.toString(), '24')
    assert.equal(portfolio.value.pnl.toString(), '0')
    assert.equal(portfolio.value.totalPnl.toString(), '24')
    assert.equal(portfolio.value.cash.toString(), '77024')
    selectedAccountId.value = 'b'
    assert.equal(portfolio.value.realized.toString(), '0')
    assert.equal(portfolio.value.totalPnl.toString(), '0')
  } finally {
    bookState.data = before
    selectedAccountId.value = selected
  }
})

test('导入持仓只从已知成本算浮盈，未报价不伪造收益，分红计入已实现', () => {
  const before = bookState.data
  const selected = selectedAccountId.value
  const previousCache = watchState.cache['FUND:110022']
  try {
    const book = emptyBook()
    book.accounts = [{ id: 'a', name: '账户甲', openingCash: '1000', date: '2026-01-01' }]
    book.instruments = [{ id: 'FUND:110022', code: '110022', name: '基金', type: 'FUND' }]
    book.openings = [
      {
        id: 'opening',
        accountId: 'a',
        instrumentId: 'FUND:110022',
        date: '2026-01-02',
        qty: '100',
        totalCost: '200',
      },
    ]
    book.corporateActions = [
      {
        id: 'dividend',
        accountId: 'a',
        instrumentId: 'FUND:110022',
        date: '2026-01-03',
        cashDate: '2026-01-03',
        type: 'dividend',
        status: 'confirmed',
        referenceQty: '100',
        cashPerShare: '0.1',
        cashAmount: '10',
        ratio: '1',
        addedQty: '0',
        source: '手动登记',
        orderConfirmed: true,
      },
    ]
    delete watchState.cache['FUND:110022']
    bookState.data = book
    selectedAccountId.value = 'a'
    assert.equal(portfolio.value.realized.toString(), '10')
    assert.equal(portfolio.value.unpriced, 1)
    assert.equal(portfolio.value.totalPnl.toString(), '10')
    watchState.cache['FUND:110022'] = {
      quote: {
        instrumentId: 'FUND:110022',
        value: '3',
        date: '2026-01-04',
        fetchedAt: '2026-01-04T00:00:00Z',
        source: '正式净值',
        kind: 'nav',
      },
      history: {
        instrumentId: 'FUND:110022',
        points: [],
        source: '正式净值',
        resolution: 'day',
        fetchedAt: '2026-01-04T00:00:00Z',
      },
    }
    assert.equal(portfolio.value.pnl.toString(), '100')
    assert.equal(portfolio.value.totalPnl.toString(), '110')
  } finally {
    bookState.data = before
    selectedAccountId.value = selected
    if (previousCache) watchState.cache['FUND:110022'] = previousCache
    else delete watchState.cache['FUND:110022']
  }
})
