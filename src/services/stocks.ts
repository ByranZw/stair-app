import type { History, Instrument, Quote } from '../domain/market'
import { marketDate, parseEtf, parseMinute, price, record } from './parsers'
import { requestJson, requestText } from './transport'

/** 股票采用市场命名空间，避免不同交易所同名代码覆盖。 */
export function stockInstrument(market: string, rawCode: string, name: string): Instrument {
  const code = market === 'us' ? rawCode.toUpperCase().replace(/\.(OQ|N|AM)$/, '') : rawCode
  const valid =
    (market === 'sh' && /^6\d{5}$/.test(code)) ||
    (market === 'sz' && /^(00|30)\d{4}$/.test(code)) ||
    (market === 'bj' && /^(4|8|92)\d{4,5}$/.test(code) && code.length === 6) ||
    (market === 'hk' && /^\d{5}$/.test(code)) ||
    (market === 'us' && /^[A-Z][A-Z0-9]*(?:[.-][A-Z0-9]+)*$/.test(code))
  if (!valid || !name.trim()) throw new Error('股票市场或代码无效')
  return {
    id: `STOCK:${market}:${code}`,
    code,
    name,
    type: 'STOCK',
    market: market as Instrument['market'],
    currency: market === 'hk' ? 'HKD' : market === 'us' ? 'USD' : 'CNY',
  }
}

/** 仅解析腾讯固定字符串载荷，不执行返回的脚本；基金和指数不会混入股票。 */
export function parseStockSearch(raw: string): Instrument[] {
  const match = /^\s*v_hint\s*=\s*("(?:[^"\\]|\\.)*")\s*;?\s*$/.exec(raw)
  if (!match) throw new Error('股票搜索来源格式无效')
  const value: string = JSON.parse(match[1])
  if (value === 'N') return []
  return value.split('^').flatMap((row) => {
    const [market, code, name, , category] = row.split('~')
    if (!/^GP(?:-A)?$/.test(category || '') || /ETF|ETN/i.test(name || '')) return []
    try {
      return [stockInstrument(market, code, name)]
    } catch {
      return []
    }
  })
}

/** 股票搜索主动提交才联网；北交所新代码缺少联想时以准确代码核验报价身份。 */
export async function searchStocks(query: string): Promise<Instrument[]> {
  const items = parseStockSearch(
    await requestText('stock-search', `/s3/?q=${encodeURIComponent(query)}&t=all`),
  )
  if (!items.length && /^(4|8|92)\d{4,5}$/.test(query) && query.length === 6) {
    const candidate = stockInstrument('bj', query, query)
    const raw = await requestJson('tencent', `/appstock/app/fqkline/get?param=bj${query},day,,,5,`)
    const node = record(record(record(raw).data)[`bj${query}`])
    const qt = record(node.qt)[`bj${query}`]
    if (Array.isArray(qt) && qt[2] === query && typeof qt[1] === 'string')
      return [stockInstrument('bj', query, qt[1])]
  }
  return items
}

/** 美股来源标识包含交易所后缀，统一只去末尾后缀，不吞掉BRK.B等股份类别。 */
function normalCode(code: string): string {
  return code.toUpperCase().replace(/\.(OQ|N|AM)$/, '')
}

/** 复用未复权日K校验，仅适配各市场身份和本地报价时间。 */
export function parseStock(
  raw: unknown,
  instrument: Instrument,
): { quote: Quote; history: History } {
  stockInstrument(instrument.market || '', instrument.code, instrument.name)
  const body = record(raw)
  const symbol = `${instrument.market}${instrument.code}`
  const node = record(record(body.data)[symbol])
  const fields = record(node.qt)[symbol]
  if (!Array.isArray(fields) || normalCode(String(fields[2])) !== instrument.code)
    throw new Error('股票代码与报价不一致')
  const stamp = String(fields[30])
  const time = /^\d{14}$/.test(stamp) ? stamp : stamp.replace(/[-/: ]/g, '')
  if (!/^\d{14}$/.test(time)) throw new Error('股票报价时间缺失')
  marketDate(`${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)}`)
  if (
    Number(time.slice(8, 10)) > 23 ||
    Number(time.slice(10, 12)) > 59 ||
    Number(time.slice(12)) > 59
  )
    throw new Error('股票报价时间无效')
  const normalized = [...fields]
  normalized[2] = instrument.code
  normalized[30] = time
  let parsed: { quote: Quote; history: History }
  try {
    parsed = parseEtf(
      { ...body, data: { [symbol]: { ...node, qt: { [symbol]: normalized } } } },
      instrument,
    )
  } catch (error) {
    throw new Error(
      error instanceof Error ? error.message.replace(/ETF/g, '股票') : '股票行情暂不可用',
    )
  }
  parsed.quote.currency = instrument.currency
  // 海外免费行情存在延迟，不把日K附带的报价称作实时行情。
  parsed.quote.delayed = instrument.market === 'us' || instrument.market === 'hk'
  return parsed
}

/** 固定新浪汇率载荷读取每一原币兑人民币值；日期与报价保留，失败不默认为1。 */
export function parseFx(raw: string, currency: 'HKD' | 'USD'): { rate: string; date: string } {
  const symbol = currency === 'USD' ? 'fx_susdcny' : 'fx_shkdcny'
  const match = new RegExp('^\\s*var hq_str_' + symbol + '="([^"]*)";?\\s*$').exec(raw)
  if (!match) throw new Error('汇率来源格式无效')
  const fields = match[1].split(',')
  const day = marketDate(fields[17])
  if (!/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(fields[0])) throw new Error('汇率时间无效')
  const rate = price(fields[8])
  const age = Date.now() - Date.parse(`${day}T${fields[0]}+08:00`)
  if (age < -60000 || age > 7 * 86400000) throw new Error('汇率已过期，请稍后刷新')
  return { rate, date: `${day} ${fields[0]}` }
}

/** 美股日K要求带交易所后缀；裸代码只返回零散旧数据，身份仍保留用户熟悉的代码。 */
async function stockDaily(instrument: Instrument, start: string, count: number): Promise<unknown> {
  const symbol = `${instrument.market}${instrument.code}`
  /** 保持同一历史起点和条数，仅替换来源要求的代码。 */
  const path = (code: string) => `/appstock/app/fqkline/get?param=${code},day,${start},,${count},`
  const raw = await requestJson('tencent', path(symbol))
  if (instrument.market !== 'us') return raw
  const node = record(record(record(raw).data)[symbol])
  const fields = record(node.qt)[symbol]
  if (!Array.isArray(fields) || normalCode(String(fields[2])) !== instrument.code)
    throw new Error('股票代码与报价不一致')
  const vendorCode = String(fields[2]).toUpperCase()
  if (!/\.(OQ|N|AM)$/.test(vendorCode)) throw new Error('美股交易所标识缺失')
  const vendorSymbol = `us${vendorCode}`
  const response = record(await requestJson('tencent', path(vendorSymbol)))
  const historyNode = record(record(response.data)[vendorSymbol])
  return {
    ...response,
    data: { [symbol]: { ...historyNode, qt: { [symbol]: record(historyNode.qt)[vendorSymbol] } } },
  }
}

/** 海外报价必须伴随有效人民币汇率，原币价格保留给图表与成交记录。 */
export async function readStockMarket(instrument: Instrument, start = '', count = 180) {
  const identity = stockInstrument(instrument.market || '', instrument.code, instrument.name)
  if (instrument.id !== identity.id || instrument.currency !== identity.currency)
    throw new Error('股票身份或币种不一致')
  const currency = identity.currency!
  const [raw, fxRaw] = await Promise.all([
    stockDaily(identity, start, count),
    currency === 'CNY'
      ? Promise.resolve('')
      : requestText('fx', `/list=${currency === 'USD' ? 'fx_susdcny' : 'fx_shkdcny'}`),
  ])
  const result = parseStock(raw, identity)
  if (currency !== 'CNY') {
    const fx = parseFx(fxRaw, currency)
    Object.assign(result.quote, {
      fxRate: fx.rate,
      fxDate: fx.date,
      fxSource: '新浪财经 · 人民币汇率',
    })
  }
  return result
}

/** 分钟数据须带来源交易日；美股源缺少日期时明确失败，不补造曲线。 */
export async function readStockMinute(instrument: Instrument): Promise<History> {
  stockInstrument(instrument.market || '', instrument.code, instrument.name)
  const symbol = `${instrument.market}${instrument.code}`
  const body = record(await requestJson('tencent', `/appstock/app/minute/query?code=${symbol}`))
  const node = record(record(body.data)[symbol])
  const qt = record(node.qt)[symbol]
  if (!Array.isArray(qt) || normalCode(String(qt[2])) !== instrument.code)
    throw new Error('股票分时代码不一致')
  const data = record(node.data)
  if (!/^\d{8}$/.test(String(data.date))) throw new Error('该股票暂无有效分时，请查看日线')
  const normalized = [...qt]
  normalized[2] = instrument.code
  return parseMinute(
    { ...body, data: { [symbol]: { ...node, qt: { [symbol]: normalized } } } },
    instrument,
  )
}
