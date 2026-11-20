import type { Instrument } from '../domain/market'
import { requestJson, requestText } from './transport'
import { readFundHistory } from './fund-history'
import { parseCorporateHints } from './corporate-hints'
import { parseEtf, parseGoldDiagnostic, parseGold, parseSearch, parseMinute } from './parsers'
import { searchStocks, readStockMarket, readStockMinute } from './stocks'
import { parseSgeDaily, parseSgeMinute } from './sge-history'

/** 上金所仅提供独立市场参考曲线，不返回或替换招行账户的策略报价。 */
export async function fetchGoldHistory(instrument: Instrument, minute = false) {
  if (instrument.id !== 'GOLD:CMB-GOLD' || instrument.type !== 'GOLD')
    throw new Error('该标的不支持黄金市场参考走势')
  const raw = await requestJson(
    'sge',
    minute ? '/graph/quotations' : '/graph/Dailyhq',
    'instid=Au99.99',
  )
  return minute ? parseSgeMinute(raw, instrument) : parseSgeDaily(raw, instrument)
}

/** 仅用户主动提交时搜索，避免每次按键请求免费来源。 */
export async function searchInstruments(
  query: string,
  type: 'ETF' | 'FUND' | 'STOCK',
): Promise<Instrument[]> {
  const key = query.trim()
  if (!key || key.length > 40) throw new Error('请输入40字以内的名称或代码')
  if (type === 'STOCK') return searchStocks(key)
  return parseSearch(
    await requestJson(
      'fund-search',
      `/FundSearch/api/FundSearchAPI.ashx?m=1&key=${encodeURIComponent(key)}`,
    ),
    type,
  )
}
/** 同次刷新核对报价与权益公告；公告失败保留旧缓存，避免除息被当成加仓跌幅。 */
export async function fetchMarket(instrument: Instrument, start = '', count = 180) {
  if (instrument.type === 'STOCK') return readStockMarket(instrument, start, count)
  if (instrument.type === 'GOLD') return fetchPrices(instrument, start, count)
  if (!/^\d{6}$/.test(instrument.code)) throw new Error('标的代码无效')
  const [result, html] = await Promise.all([
    fetchPrices(instrument, start, count),
    requestText('fund-actions', `/fhsp_${instrument.code}.html`),
  ])
  result.quote.actions = parseCorporateHints(html, instrument)
  return result
}
/** 报价与最近180个有效交易日一并获取，实际范围由响应决定。 */
async function fetchPrices(instrument: Instrument, start: string, count: number) {
  if (instrument.type === 'GOLD')
    return parseGold(
      await requestJson(
        'cmb',
        '/product/v1/func/market-center',
        'params=%5B%7B%22prdType%22%3A%22H%22%2C%22prdCode%22%3A%22%22%7D%5D',
      ),
      instrument,
    )
  if (!/^\d{6}$/.test(instrument.code)) throw new Error('标的代码无效')
  if (instrument.type === 'ETF') {
    if (!instrument.market || !/^(5\d{5}|1[568]\d{4})$/.test(instrument.code))
      throw new Error('ETF市场代码无效')
    return parseEtf(
      await requestJson(
        'tencent',
        `/appstock/app/fqkline/get?param=${instrument.market}${instrument.code},day,${start},,${count},`,
      ),
      instrument,
    )
  }
  return readFundHistory(instrument, count, (page) =>
    requestJson(
      'fund-nav',
      `/f10/lsjz?fundCode=${instrument.code}&pageIndex=${page}&pageSize=20&startDate=${start}&endDate=`,
    ),
  )
}
/** 手动检查同一公开报价来源，不读取银行账户或交易数据。 */
export async function diagnoseGold() {
  return parseGoldDiagnostic(
    await requestJson(
      'cmb',
      '/product/v1/func/market-center',
      'params=%5B%7B%22prdType%22%3A%22H%22%2C%22prdCode%22%3A%22%22%7D%5D',
    ),
  )
}

/** 分时按用户切换时查询，不启动持续轮询，也不把它作为场外基金估值。 */
export async function fetchMinute(instrument: Instrument) {
  if (instrument.type === 'STOCK') return readStockMinute(instrument)
  if (
    instrument.type !== 'ETF' ||
    !/^(sh|sz)$/.test(instrument.market || '') ||
    !/^\d{6}$/.test(instrument.code)
  )
    throw new Error('仅场内ETF支持分时')
  return parseMinute(
    await requestJson(
      'tencent',
      `/appstock/app/minute/query?code=${instrument.market}${instrument.code}`,
    ),
    instrument,
  )
}
