import test from 'node:test'
import assert from 'node:assert/strict'
import fixtures from './fixtures/stock-markets.json'
import { parseFx, parseStock, parseStockSearch, stockInstrument } from '../src/services/stocks'

test('股票搜索按市场隔离并保留美股股份类别，剔除基金和ETF', () => {
  const raw =
    'v_hint="sh~600519~贵州茅台~gzmt~GP-A^hk~00700~腾讯控股~txkg~GP^us~brk.b.n~伯克希尔B~b~GP^sh~510300~沪深300ETF~e~ETF^jj~000001~基金~j~KJ";'
  assert.deepEqual(
    parseStockSearch(raw).map((i) => [i.id, i.currency]),
    [
      ['STOCK:sh:600519', 'CNY'],
      ['STOCK:hk:00700', 'HKD'],
      ['STOCK:us:BRK.B', 'USD'],
    ],
  )
  assert.deepEqual(parseStockSearch('v_hint="N";'), [])
  assert.throws(() => parseStockSearch('alert(1)'))
  assert.throws(() => stockInstrument('sh', '510300', 'ETF'))
})

test('公开四市场响应保留原币行情、未复权日K与市场当地时间', () => {
  for (const row of fixtures) {
    const symbol = new URL(row.url).searchParams.get('param')!.split(',')[0]
    const market = symbol.slice(0, 2)
    const code = symbol.slice(2)
    const instrument = stockInstrument(market, code, code)
    const result = parseStock({ code: 0, data: { [symbol]: row.node } }, instrument)
    assert.equal(result.quote.instrumentId, instrument.id)
    assert.equal(result.quote.currency, instrument.currency)
    assert.ok(result.history.points.length > 0)
    assert.match(result.quote.date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
    assert.equal(result.quote.delayed, market === 'us' || market === 'hk')
  }
})

test('海外代码与日期错配不能进入行情', () => {
  const row = fixtures[3]
  const instrument = stockInstrument('us', 'MSFT', '微软')
  assert.throws(() => parseStock({ code: 0, data: { usMSFT: row.node } }, instrument))
})

test('人民币汇率必须包含有效价格和来源时间，过期失败', (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-20T20:35:00+08:00'))
  const value =
    '20:34:00,6.6784,6.6799,6.6950,136,6.677,6.681,6.6674,6.6784,人民币,-.24,-.01,.01,来源,0,0,,2026-11-20'
  assert.deepEqual(parseFx(`var hq_str_fx_susdcny="${value}";`, 'USD'), {
    rate: '6.6784',
    date: '2026-11-20 20:34:00',
  })
  assert.throws(
    () => parseFx(`var hq_str_fx_susdcny="${value.replace('2026-11-20', '2026-10-20')}";`, 'USD'),
    /过期/,
  )
  assert.throws(() => parseFx(`var hq_str_fx_susdcny="${value}";`, 'HKD'))
})

test('美股完整日K使用来源交易所后缀，账本身份仍是AAPL', async (t) => {
  const { readStockMarket } = await import('../src/services/stocks')
  const { default: fullHistory } = await import('./fixtures/us-stock-history.json')
  const calls: string[] = []
  const base = fixtures[3]
  const day = new Date().toISOString().slice(0, 10)
  const fx = `var hq_str_fx_susdcny="00:00:00,6.6,6.6,6.6,0,6.6,6.6,6.6,6.6,人民币,0,0,0,来源,0,0,,${day}";`
  t.mock.method(Date, 'now', () => Date.parse(`${day}T12:00:00+08:00`))
  const previous = (globalThis as any).uni
  ;(globalThis as any).uni = {
    request: (options: any) => {
      calls.push(options.url)
      const body = options.url.includes('/list=')
        ? fx
        : options.url.includes('usAAPL.OQ,')
          ? JSON.stringify(fullHistory)
          : JSON.stringify({ code: 0, data: { usAAPL: base.node } })
      options.success({ statusCode: 200, data: body })
    },
  }
  try {
    const result = await readStockMarket(stockInstrument('us', 'AAPL', '苹果'))
    assert.equal(result.history.points.length, 10)
    assert.equal(result.quote.instrumentId, 'STOCK:us:AAPL')
    assert.equal(result.quote.fxRate, '6.6')
    assert.ok(calls.some((url) => url.includes('usAAPL.OQ,')))
  } finally {
    ;(globalThis as any).uni = previous
  }
})
