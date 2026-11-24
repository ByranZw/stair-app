import type { Book, Position, Projection } from './book'
import type { History, Quote } from './market'
import { quoteFx } from './currency'
import { D } from './money'
import type Decimal from 'decimal.js'

/** 日指标属于报价日；收益使用人民币，海外缺少昨日汇率时明确为估算。 */
export interface DailyReturn {
  date?: string
  changePct?: Decimal
  profit?: Decimal
  estimated: boolean
  held: boolean
}

/** 只接收有效正价格，兼容旧行情缓存缺失日基准的情况。 */
function positivePrice(value?: string): Decimal | undefined {
  if (!value || !/^\d+(?:\.\d+)?$/.test(value)) return undefined
  const parsed = new D(value)
  return parsed.isFinite() && parsed.gt(0) ? parsed : undefined
}

/** 净值优先采用供应方公布的日增长率，避免分红日拿裸净值变化冒充涨跌幅。 */
export function quoteDailyChange(quote?: Quote): Decimal | undefined {
  if (!quote) return undefined
  if (quote.changePercent !== undefined && /^[+-]?\d+(?:\.\d+)?$/.test(quote.changePercent))
    return new D(quote.changePercent)
  const value = positivePrice(quote.value)
  const previous = positivePrice(quote.previous)
  return value && previous ? value.minus(previous).div(previous).mul(100) : undefined
}

/** 以昨仓市值和当日实际净收支计算收益；当日买入不吃到买入前的涨幅，清仓保留当天收益。 */
export function positionDailyReturn(
  book: Book,
  projection: Projection,
  position: Position,
  previousPosition: Position | undefined,
  quote?: Quote,
  history?: History,
): DailyReturn {
  const result: DailyReturn = {
    date: quote?.date.slice(0, 10),
    changePct: quoteDailyChange(quote),
    estimated:
      !!quote &&
      (quote.currency === 'USD' ||
        quote.currency === 'HKD' ||
        /^STOCK:(hk|us):/.test(quote.instrumentId)),
    held: new D(position.qty).gt(0),
  }
  if (!quote || quote.instrumentId !== position.instrumentId) return result
  const day = result.date!
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(Date.parse(day))) return result
  const value = positivePrice(quote.value)
  const rate = quoteFx(quote)
  if (!value || !rate) return result
  const trades = book.trades.filter(
    (trade) =>
      trade.accountId === position.accountId &&
      trade.instrumentId === position.instrumentId &&
      trade.status === 'confirmed',
  )
  const actions = (book.corporateActions || []).filter(
    (action) =>
      action.accountId === position.accountId && action.instrumentId === position.instrumentId,
  )
  const opening = book.openings.find(
    (row) => row.accountId === position.accountId && row.instrumentId === position.instrumentId,
  )
  if (
    (opening && opening.date >= day) ||
    trades.some((trade) => trade.date > day) ||
    actions.some(
      (action) =>
        action.status === 'confirmed' &&
        ((action.type === 'split' && action.date > day) ||
          (action.type === 'reinvest' && (action.cashDate || action.date) > day)),
    )
  )
    return result
  const todayTrades = trades.filter((trade) => trade.date === day)
  if (
    quote.kind === 'market' &&
    todayTrades.some(
      (trade) => !trade.time || quote.date.length < 16 || trade.time > quote.date.slice(11, 16),
    )
  )
    return result
  const previousQty = new D(previousPosition?.qty || 0)
  const todayActions = actions.filter((action) => action.date === day)
  if (
    todayActions.some((action) => action.status !== 'confirmed') ||
    quote.corporateAction ||
    quote.actions?.some(
      (hint) =>
        previousQty.gt(0) &&
        hint.date === day &&
        !todayActions.some(
          (action) =>
            action.status === 'confirmed' &&
            (action.type === hint.type || (hint.type === 'dividend' && action.type === 'reinvest')),
        ),
    )
  )
    return result
  let previous = positivePrice(quote.previous)
  if (todayActions.length) {
    const previousPoints = history?.points.filter((point) => point.date.slice(0, 10) < day) || []
    const previousPoint = previousPoints[previousPoints.length - 1]
    previous = positivePrice(previousPoint?.value)
  }
  if (previousQty.gt(0) && !previous) return result
  if (!result.held && !todayTrades.length && !todayActions.length) return result
  let profit = value
    .mul(position.qty)
    .minus(previousQty.mul(previous || 0))
    .mul(rate)
  for (const trade of todayTrades) {
    const net = projection.trades[trade.id]?.net
    if (net === undefined) return result
    profit = trade.side === 'sell' ? profit.plus(net) : profit.minus(net)
  }
  for (const action of actions.filter((row) => row.status === 'confirmed')) {
    if (action.type !== 'split' && action.date === day) profit = profit.plus(action.cashAmount)
    if (action.type === 'reinvest' && (action.cashDate || action.date) === day)
      profit = profit.minus(action.cashAmount)
  }
  result.profit = profit
  return result
}
