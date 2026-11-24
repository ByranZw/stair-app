import test from 'node:test'
import assert from 'node:assert/strict'
import { emptyBook, type Book, type CorporateAction, type Trade } from '../src/domain/book'
import type { History, Quote } from '../src/domain/market'
import { projectBook } from '../src/domain/ledger'
import { positionDailyReturn, quoteDailyChange } from '../src/domain/daily-returns'
import { parseFund } from '../src/services/parsers'
import { bookState, selectedAccountId } from '../src/state/book'
import { watchState } from '../src/state/watchlist'
import { watchReturns } from '../src/state/daily-returns'
import { portfolio } from '../src/state/portfolio'

/** 昨日已有100份、报价日为1月3日，方便独立核对市场涨跌与个人收益。 */
function fixture(): Book {
  const book = emptyBook()
  book.accounts = [{ id: 'a', name: '账户甲', openingCash: '10000', date: '2026-01-01' }]
  book.instruments = [
    { id: 'ETF:510300', code: '510300', name: '测试ETF', type: 'ETF', market: 'sh' },
  ]
  book.openings = [
    {
      id: 'opening',
      accountId: 'a',
      instrumentId: 'ETF:510300',
      date: '2026-01-02',
      qty: '100',
      totalCost: '800',
    },
  ]
  return book
}

/** 同一天内按实际先后顺序记账，费用直接进入账本净额。 */
function trade(extra: Partial<Trade> = {}): Trade {
  return {
    id: 'trade',
    accountId: 'a',
    instrumentId: 'ETF:510300',
    side: 'buy',
    status: 'confirmed',
    date: '2026-01-03',
    time: '10:00',
    sequence: 1,
    orderConfirmed: true,
    qty: '20',
    price: '11',
    fee: '1',
    pendingAmount: '',
    ...extra,
  }
}

/** 固定原币市场报价，额外参数用于迟到净值、海外和权益日场景。 */
function quote(extra: Partial<Quote> = {}): Quote {
  return {
    instrumentId: 'ETF:510300',
    value: '12',
    previous: '10',
    date: '2026-01-03 15:00:00',
    fetchedAt: '2026-01-03T07:00:00Z',
    source: '测试行情',
    kind: 'market',
    ...extra,
  }
}

/** 从真实账本重放昨日仓位，不在测试中伪造成本或现金结果。 */
function daily(book: Book, current = quote(), history?: History) {
  const projection = projectBook(book)
  const previous = projectBook(book, '2026-01-02')
  const key = `a/${book.instruments[0].id}`
  return positionDailyReturn(
    book,
    projection,
    projection.positions[key],
    previous.positions[key],
    current,
    history,
  )
}

test('日涨跌与累计成本无关，正常持仓日收益按昨收计算', () => {
  const result = daily(fixture())
  assert.equal(result.changePct?.toString(), '20')
  assert.equal(result.profit?.toString(), '200')
  assert.equal(result.date, '2026-01-03')
  assert.equal(result.estimated, false)
})

test('日内买入仅计成交后的收益并扣费，卖出与清仓仍保留当日收益', () => {
  const book = fixture()
  book.trades = [trade()]
  assert.equal(daily(book).profit?.toString(), '219')
  book.trades = [trade({ side: 'sell', qty: '40' })]
  assert.equal(daily(book).profit?.toString(), '159')
  book.trades = [trade({ side: 'sell', qty: '100' })]
  assert.equal(daily(book).profit?.toString(), '99')
  assert.equal(daily(book).held, false)
})

test('日内多次买卖用实际流水而非现持仓乘整日涨幅，待确认不算成交', () => {
  const book = fixture()
  book.instruments[0] = { id: 'FUND:110022', code: '110022', name: '基金', type: 'FUND' }
  book.openings[0].instrumentId = 'FUND:110022'
  book.trades = [
    trade({ instrumentId: 'FUND:110022' }),
    trade({
      instrumentId: 'FUND:110022',
      id: 'sell',
      side: 'sell',
      time: '14:00',
      sequence: 2,
      qty: '50',
      price: '11.5',
      fee: '2',
    }),
    trade({
      instrumentId: 'FUND:110022',
      id: 'pending',
      status: 'pending',
      time: '14:30',
      sequence: 3,
      qty: '',
      price: '',
      fee: '0',
      pendingAmount: '100',
    }),
  ]
  assert.equal(daily(book, quote({ instrumentId: 'FUND:110022' })).profit?.toString(), '192')
})

test('日内旧报价不能估值后来发生的成交，黄金无同侧昨收时保留缺失', () => {
  const book = fixture()
  book.trades = [trade({ time: '14:00' })]
  assert.equal(daily(book, quote({ date: '2026-01-03 11:00:00' })).profit, undefined)
  book.trades[0].time = ''
  assert.equal(daily(book, quote({ date: '2026-01-03 11:00:00' })).profit, undefined)
  assert.equal(daily(book, quote({ date: '2026-01-03' })).profit, undefined)
  book.trades[0].time = '10:00'
  assert.equal(daily(book, quote({ date: '2026-01-03 11:00:00' })).profit?.toString(), '219')
  book.instruments = [{ id: 'GOLD:CMB-GOLD', code: 'CMB-GOLD', name: '招行黄金账户', type: 'GOLD' }]
  book.openings[0].instrumentId = 'GOLD:CMB-GOLD'
  book.trades = []
  const result = daily(book, quote({ instrumentId: 'GOLD:CMB-GOLD', previous: undefined }))
  assert.equal(result.changePct, undefined)
  assert.equal(result.profit, undefined)
})

test('除息日首次买入无昨日权益资格，不要求确认不存在的分红', () => {
  const book = fixture()
  book.openings = []
  book.trades = [trade({ price: '8', qty: '100', fee: '0' })]
  const current = quote({
    value: '8',
    previous: '10',
    actions: [
      { date: '2026-01-03', type: 'dividend', cashPerShare: '2', ratio: '', source: '公告' },
    ],
  })
  assert.equal(daily(book, current).profit?.toString(), '0')
})

test('红利再投匹配真实分红公告，旧安卓没有Array.at也能计算权益日', () => {
  const book = fixture()
  book.corporateActions = [
    {
      id: 'reinvest',
      accountId: 'a',
      instrumentId: 'ETF:510300',
      date: '2026-01-03',
      cashDate: '2026-01-03',
      type: 'reinvest',
      status: 'confirmed',
      referenceQty: '100',
      cashPerShare: '2',
      cashAmount: '200',
      ratio: '',
      addedQty: '25',
      source: '测试公告',
      orderConfirmed: true,
    },
  ]
  const current = quote({
    value: '8',
    previous: '8',
    actions: [
      { date: '2026-01-03', type: 'dividend', cashPerShare: '2', ratio: '', source: '公告' },
    ],
  })
  const history: History = {
    instrumentId: 'ETF:510300',
    points: [{ date: '2026-01-02', value: '10' }],
    source: '未复权',
    fetchedAt: '',
  }
  const previousAt = Array.prototype.at
  try {
    ;(Array.prototype as any).at = undefined
    assert.equal(daily(book, current, history).profit?.toString(), '0')
  } finally {
    Array.prototype.at = previousAt
  }
  book.corporateActions[0].cashDate = '2026-01-04'
  const projection = projectBook(book)
  const before = projectBook(book, '2026-01-03')
  const settlementQuote = { ...current, date: '2026-01-04 15:00:00' }
  assert.equal(
    positionDailyReturn(
      book,
      projection,
      projection.positions['a/ETF:510300'],
      before.positions['a/ETF:510300'],
      settlementQuote,
    ).profit?.toString(),
    '0',
  )
})

test('报价不涨不跌为真实零，缺日基准、缺报价与当日导入不能编造为零', () => {
  const book = fixture()
  assert.equal(daily(book, quote({ value: '10' })).profit?.toString(), '0')
  assert.equal(daily(book, quote({ value: '10' })).changePct?.toString(), '0')
  assert.equal(daily(book, quote({ previous: undefined })).profit, undefined)
  assert.equal(daily(book, quote({ previous: '0' })).changePct, undefined)
  const projection = projectBook(book)
  assert.equal(
    positionDailyReturn(book, projection, projection.positions['a/ETF:510300'], undefined).profit,
    undefined,
  )
  book.openings[0].date = '2026-01-03'
  assert.equal(daily(book).profit, undefined)
})

test('当日首次实际买入不需要虚构昨仓；报价后已有成交时不混用旧价和新数量', () => {
  const book = fixture()
  book.openings = []
  book.trades = [trade()]
  assert.equal(daily(book, quote({ previous: undefined })).profit?.toString(), '19')
  book.trades[0].date = '2026-01-04'
  assert.equal(daily(book).profit, undefined)
})

test('港美股按当前汇率折算并标记估算，净收支复用实际人民币结算', () => {
  const book = fixture()
  book.instruments = [
    {
      id: 'STOCK:hk:00700',
      code: '00700',
      name: '腾讯控股',
      type: 'STOCK',
      market: 'hk',
      currency: 'HKD',
    },
  ]
  book.openings[0].instrumentId = book.instruments[0].id
  book.trades = [trade({ instrumentId: book.instruments[0].id, settlementAmount: '200' })]
  const current = quote({
    instrumentId: book.instruments[0].id,
    currency: 'HKD',
    fxRate: '0.9',
    fxDate: '2026-01-03 12:00:00',
  })
  const result = daily(book, current)
  assert.equal(result.profit?.toString(), '196')
  assert.equal(result.estimated, true)
  assert.equal(result.changePct?.toString(), '20')
  assert.equal(daily(book, { ...current, fxRate: undefined }).profit, undefined)
})

test('正式净值优先用公布日增长率，日期沿用净值日而非抓取日', () => {
  const fund = { id: 'FUND:110022', code: '110022', name: '测试基金', type: 'FUND' as const }
  const raw = {
    ErrCode: 0,
    Data: {
      LSJZList: [
        { FSRQ: '2026-01-03', DWJZ: '9.9', JZZZL: '1.00' },
        { FSRQ: '2026-01-02', DWJZ: '10', JZZZL: '--' },
      ],
    },
  }
  const parsed = parseFund(raw, fund)
  assert.equal(quoteDailyChange(parsed.quote)?.toString(), '1')
  assert.equal(parsed.quote.date, '2026-01-03')
  raw.Data.LSJZList[0].JZZZL = '--'
  assert.equal(quoteDailyChange(parseFund(raw, fund).quote)?.toString(), '-1')
})

test('现金分红在除息日抵消价格减少，到账日不重复计收益；未知权益不假算', () => {
  const book = fixture()
  const action: CorporateAction = {
    id: 'dividend',
    accountId: 'a',
    instrumentId: 'ETF:510300',
    date: '2026-01-03',
    cashDate: '2026-01-05',
    type: 'dividend',
    status: 'confirmed',
    referenceQty: '100',
    cashPerShare: '0.2',
    cashAmount: '20',
    ratio: '',
    addedQty: '',
    source: '测试公告',
    orderConfirmed: true,
  }
  book.corporateActions = [action]
  const history: History = {
    instrumentId: 'ETF:510300',
    points: [{ date: '2026-01-02', value: '10' }],
    source: '未复权收盘',
    fetchedAt: '',
  }
  assert.equal(
    daily(book, quote({ value: '9.8', previous: '9.8' }), history).profit?.toString(),
    '0',
  )
  const current = quote({ value: '9.8', previous: '9.8', date: '2026-01-05 15:00:00' })
  const projection = projectBook(book)
  const before = projectBook(book, '2026-01-04')
  assert.equal(
    positionDailyReturn(
      book,
      projection,
      projection.positions['a/ETF:510300'],
      before.positions['a/ETF:510300'],
      current,
    ).profit?.toString(),
    '0',
  )
  book.corporateActions = []
  assert.equal(
    daily(
      book,
      quote({
        actions: [
          { date: '2026-01-03', type: 'dividend', cashPerShare: '0.2', ratio: '', source: '公告' },
        ],
      }),
    ).profit,
    undefined,
  )
})

test('拆分与红利再投按实际份额变化核算，不把增加份额算成额外盈利', () => {
  const book = fixture()
  book.corporateActions = [
    {
      id: 'split',
      accountId: 'a',
      instrumentId: 'ETF:510300',
      date: '2026-01-03',
      type: 'split',
      status: 'confirmed',
      referenceQty: '100',
      cashPerShare: '',
      cashAmount: '',
      ratio: '2',
      addedQty: '',
      source: '测试公告',
      orderConfirmed: true,
    },
  ]
  const history: History = {
    instrumentId: 'ETF:510300',
    points: [{ date: '2026-01-02', value: '10' }],
    source: '未复权',
    fetchedAt: '',
  }
  assert.equal(daily(book, quote({ value: '5', previous: '5' }), history).profit?.toString(), '0')
  book.corporateActions = [
    {
      ...book.corporateActions[0],
      type: 'reinvest',
      ratio: '',
      cashPerShare: '0.2',
      cashAmount: '20',
      addedQty: '2',
      cashDate: '2026-01-03',
    },
  ]
  assert.equal(
    daily(book, quote({ value: '10', previous: '10' }), history).profit?.toString(),
    '20',
  )
})

test('自选跨账户汇总与持仓筛选一致，部分缺失不展示部分收益，未持有不显示0', () => {
  const previousBook = bookState.data
  const previousSelected = selectedAccountId.value
  const previousItems = watchState.items
  const previousCache = watchState.cache['ETF:510300']
  try {
    const book = fixture()
    book.accounts.push({ id: 'b', name: '账户乙', openingCash: '10000', date: '2026-01-01' })
    book.openings.push({ ...book.openings[0], id: 'opening-b', accountId: 'b', qty: '50' })
    bookState.data = book
    watchState.items = book.instruments
    watchState.cache['ETF:510300'] = {
      quote: quote(),
      history: { instrumentId: 'ETF:510300', points: [], source: '', fetchedAt: '' },
    }
    selectedAccountId.value = 'a'
    assert.equal(portfolio.value.rows[0].daily.profit?.toString(), '200')
    assert.equal(watchReturns.value['ETF:510300'].profit?.toString(), '300')
    selectedAccountId.value = 'b'
    assert.equal(portfolio.value.rows[0].daily.profit?.toString(), '100')
    assert.equal(watchReturns.value['ETF:510300'].profit?.toString(), '300')
    bookState.data = {
      ...book,
      openings: book.openings.map((opening) =>
        opening.accountId === 'b' ? { ...opening, date: '2026-01-03' } : opening,
      ),
    }
    assert.equal(watchReturns.value['ETF:510300'].profit, undefined)
    bookState.data = { ...book, openings: [] }
    assert.equal(watchReturns.value['ETF:510300'].held, false)
    assert.equal(watchReturns.value['ETF:510300'].profit, undefined)
    bookState.data = {
      ...book,
      openings: [book.openings[0]],
      trades: [trade({ accountId: 'b', price: '8', qty: '100', fee: '0' })],
      corporateActions: [
        {
          id: 'dividend-a',
          accountId: 'a',
          instrumentId: 'ETF:510300',
          date: '2026-01-03',
          type: 'dividend',
          status: 'confirmed',
          referenceQty: '100',
          cashPerShare: '2',
          cashAmount: '200',
          ratio: '',
          addedQty: '',
          source: '公告',
          orderConfirmed: true,
        },
      ],
    }
    watchState.cache['ETF:510300'] = {
      quote: quote({
        value: '8',
        previous: '8',
        actions: [
          { date: '2026-01-03', type: 'dividend', cashPerShare: '2', ratio: '', source: '公告' },
        ],
      }),
      history: {
        instrumentId: 'ETF:510300',
        points: [{ date: '2026-01-02', value: '10' }],
        source: '未复权',
        fetchedAt: '',
      },
    }
    assert.equal(String(watchReturns.value['ETF:510300'].profit), '0')
  } finally {
    bookState.data = previousBook
    selectedAccountId.value = previousSelected
    watchState.items = previousItems
    if (previousCache) watchState.cache['ETF:510300'] = previousCache
    else delete watchState.cache['ETF:510300']
  }
})
