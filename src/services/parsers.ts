import type { History, Instrument, Quote } from '../domain/market'

/** 验证远端对象边界，畸形响应不能进入行情缓存。 */
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('行情数据结构不完整')
  return value as Record<string, unknown>
}
/** 接受正十进制价格，拒绝空值、NaN和暂停净值占位符。 */
export function price(value: unknown): string {
  const text = String(value ?? '')
  if (!/^\d+(?:\.\d+)?$/.test(text) || Number(text) <= 0) throw new Error('行情价格无效')
  return text
}
/** 市场日期单独保留，不能用抓取日期替代净值所属日。 */
export function marketDate(value: unknown): string {
  const date = String(value)
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    Number.isNaN(Date.parse(date)) ||
    new Date(date).toISOString().slice(0, 10) !== date
  )
    throw new Error('行情日期无效')
  return date
}
/** 只保留基金身份记录；ETF联接归场外，股票不能凭同名进入结果。 */
export function parseSearch(raw: unknown, type: 'ETF' | 'FUND'): Instrument[] {
  const body = record(raw)
  if (Number(body.ErrCode) !== 0 || !Array.isArray(body.Datas)) throw new Error('标的搜索暂不可用')
  return body.Datas.flatMap((item) => {
    const row = record(item)
    if (!row.FundBaseInfo || !/^\d{6}$/.test(String(row.CODE)) || typeof row.NAME !== 'string')
      return []
    const code = String(row.CODE)
    const etf =
      /ETF/i.test(row.NAME) && !/联接/.test(row.NAME) && /^(5\d{5}|1[568]\d{4})$/.test(code)
    if ((type === 'ETF') !== etf) return []
    return [
      {
        id: `${type}:${code}`,
        code,
        name: row.NAME,
        type,
        ...(etf ? { market: code.startsWith('5') ? ('sh' as const) : ('sz' as const) } : {}),
      },
    ]
  })
}
/** 腾讯UTF-8日线携带即时字段，免去执行远端JS或混淆GBK编码。 */
export function parseEtf(raw: unknown, instrument: Instrument): { quote: Quote; history: History } {
  const body = record(raw)
  if (body.code !== 0) throw new Error('ETF行情暂不可用')
  const symbol = `${instrument.market}${instrument.code}`
  const node = record(record(body.data)[symbol])
  const fields = record(node.qt)[symbol]
  if (!Array.isArray(fields) || String(fields[2]) !== instrument.code)
    throw new Error('ETF代码与报价不一致')
  const time = String(fields[30])
  if (!/^\d{14}$/.test(time)) throw new Error('ETF报价时间缺失')
  const date = `${time.slice(0, 4)}-${time.slice(4, 6)}-${time.slice(6, 8)} ${time.slice(8, 10)}:${time.slice(10, 12)}:${time.slice(12, 14)}`
  if (!Array.isArray(node.day)) throw new Error('ETF历史数据缺失')
  const points = node.day
    .map((row) => {
      if (!Array.isArray(row) || row.length < 6) throw new Error('ETF历史数据格式错误')
      const open = price(row[1]),
        close = price(row[2]),
        high = price(row[3]),
        low = price(row[4])
      if (!/^\d+(?:\.\d+)?$/.test(String(row[5]))) throw new Error('ETF成交量无效')
      if (
        Number(high) < Math.max(Number(open), Number(close)) ||
        Number(low) > Math.min(Number(open), Number(close))
      )
        throw new Error('ETF日K高低价不一致')
      return { date: marketDate(row[0]), value: close, open, high, low, volume: String(row[5]) }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
  const fetchedAt = new Date().toISOString()
  return {
    quote: {
      instrumentId: instrument.id,
      value: price(fields[3]),
      previous: price(fields[4]),
      date,
      source: '腾讯财经 · 市场价',
      fetchedAt,
      kind: 'market',
    },
    history: { instrumentId: instrument.id, points, source: '腾讯财经 · 未复权收盘价', fetchedAt },
  }
}

/** 分时仅使用同代码当天真实分钟价；日期与时刻来自来源，不能用抓取时间补造。 */
export function parseMinute(raw: unknown, instrument: Instrument): History {
  const body = record(raw)
  if (body.code !== 0) throw new Error('ETF分时来源暂不可用')
  const symbol = `${instrument.market}${instrument.code}`
  const node = record(record(body.data)[symbol])
  const identity = record(node.qt)[symbol]
  if (!Array.isArray(identity) || String(identity[2]) !== instrument.code)
    throw new Error('ETF分时代码不一致')
  const data = record(node.data),
    stamp = String(data.date)
  if (!/^\d{8}$/.test(stamp) || !Array.isArray(data.data)) throw new Error('ETF分时日期或序列缺失')
  const day = marketDate(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}`)
  const points = data.data
    .map((row) => {
      if (typeof row !== 'string') throw new Error('ETF分时格式无效')
      const [time, value] = row.split(/\s+/)
      if (!/^\d{4}$/.test(time) || Number(time.slice(0, 2)) > 23 || Number(time.slice(2)) > 59)
        throw new Error('ETF分时时刻无效')
      return { date: `${day} ${time.slice(0, 2)}:${time.slice(2)}`, value: price(value) }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
  if (!points.length || new Set(points.map((p) => p.date)).size !== points.length)
    throw new Error('ETF分时无有效数据或时刻重复')
  return {
    instrumentId: instrument.id,
    points,
    source: '腾讯财经 · 分钟成交价',
    fetchedAt: new Date().toISOString(),
    resolution: 'minute',
  }
}
/** 正式单位净值按所属日期排序，不使用盘中估值或抓取时间代替。 */
export function parseFund(
  raw: unknown,
  instrument: Instrument,
): { quote: Quote; history: History } {
  const body = record(raw)
  if (body.ErrCode !== 0) throw new Error('正式净值来源暂不可用')
  const rows = record(body.Data).LSJZList
  if (!Array.isArray(rows) || !rows.length) throw new Error('该基金尚无可用正式净值')
  const points = rows
    .map((item) => {
      const row = record(item)
      const change = String(row.JZZZL ?? '')
      return {
        date: marketDate(row.FSRQ),
        value: price(row.DWJZ),
        changePercent: /^[+-]?\d+(?:\.\d+)?$/.test(change) ? change : undefined,
      }
    })
    .sort((a, b) => a.date.localeCompare(b.date))
  const latest = points[points.length - 1],
    fetchedAt = new Date().toISOString()
  return {
    quote: {
      instrumentId: instrument.id,
      value: latest.value,
      previous: points[points.length - 2]?.value,
      changePercent: latest.changePercent,
      date: latest.date,
      source: '东方财富 · 正式单位净值',
      fetchedAt,
      kind: 'nav',
    },
    history: { instrumentId: instrument.id, points, source: '东方财富 · 正式单位净值', fetchedAt },
  }
}
/** 解析招行固定公开响应的双侧原值，供行情转换和来源诊断共用。 */
export function parseGoldDiagnostic(raw: unknown): {
  buyField: string
  sellField: string
  time: string
} {
  const body = record(raw)
  if (body.success !== true || body.code !== 'SUC0000') throw new Error('招行公开报价暂不可用')
  const data = record(body.data),
    quote = record(data.FQAMBPRCZ1)
  return {
    buyField: price(quote.zBuyPrc),
    sellField: price(quote.zSelPrc),
    time: String(data.NowTime ?? '未知时间'),
  }
}

/** 用户银行端黄金账户双侧价对照：高侧zBuyPrc为客户买入，低侧zSelPrc为客户卖出/赎回。 */
export function parseGold(
  raw: unknown,
  instrument: Instrument,
): { quote: Quote; history: History } {
  if (
    instrument.id !== 'GOLD:CMB-GOLD' ||
    instrument.code !== 'CMB-GOLD' ||
    instrument.type !== 'GOLD'
  )
    throw new Error('招行黄金账户身份不一致')
  const body = record(raw),
    diagnostic = parseGoldDiagnostic(raw),
    data = record(body.data)
  if (Number(diagnostic.buyField) < Number(diagnostic.sellField))
    throw new Error('招行黄金账户买卖价方向异常')
  const time = diagnostic.time.replace(/\//g, '-')
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(time)) throw new Error('招行报价来源时间缺失')
  marketDate(time.slice(0, 10))
  if (
    Number(time.slice(11, 13)) > 23 ||
    Number(time.slice(14, 16)) > 59 ||
    Number(time.slice(17, 19)) > 59
  )
    throw new Error('招行报价来源时刻无效')
  const fetchedAt = new Date().toISOString()
  const quote: Quote = {
    instrumentId: instrument.id,
    value: diagnostic.sellField,
    buyValue: diagnostic.buyField,
    date: time,
    source: '招商银行 · 黄金账户 · 客户卖出价',
    fetchedAt,
    kind: 'market',
    tradable: data.MarketDay === true && data.QuotedPrice === true,
  }
  return {
    quote,
    history: {
      instrumentId: instrument.id,
      source: '上金所 Au99.99 · 市场参考收盘价',
      resolution: 'day',
      fetchedAt,
      points: [],
    },
  }
}
