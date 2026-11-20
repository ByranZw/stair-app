import type { History, HistoryPoint, Quote } from './market'
import { D, money } from './money'

/** 日变化只对照实际前次采样，保留基准日期和间隔而不假称正式日涨跌。 */
export interface GoldSampleChange extends HistoryPoint {
  previousDate?: string
  changeAmount?: string
  changePercent?: string
  gapDays?: number
}

/** 招行报价使用北京时间，不能随着设备时区改变所属交易日期。 */
export function goldToday(now = new Date()): string {
  return new Date(now.getTime() + 8 * 3600000).toISOString().slice(0, 10)
}

/** 仅保留当天有效交易报价；分钟内用较新的来源秒替换，缺失分钟不补造。 */
export function goldMinuteHistory(
  previous: History | undefined,
  quote: Quote,
  now = new Date(),
): History {
  const today = goldToday(now)
  const rows = new Map(
    (previous?.instrumentId === quote.instrumentId ? previous.points : [])
      .filter((point) => point.date.slice(0, 10) === today)
      .map((point) => [point.date, point]),
  )
  const ordered = [...rows.values()].sort((a, b) => a.date.localeCompare(b.date))
  const latest = ordered[ordered.length - 1]
  if (
    quote.instrumentId === 'GOLD:CMB-GOLD' &&
    quote.tradable === true &&
    quote.date.slice(0, 10) === today &&
    /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(quote.date) &&
    (!latest || quote.date > (latest.sampledAt || latest.date + ':00'))
  ) {
    const date = quote.date.slice(0, 16)
    rows.set(date, { date, value: quote.value, buyValue: quote.buyValue, sampledAt: quote.date })
  }
  return {
    instrumentId: quote.instrumentId,
    source: '招行黄金账户 · 本机前台分钟采样（客户卖出价）',
    fetchedAt: quote.fetchedAt,
    resolution: 'minute',
    points: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)).slice(-1440),
  }
}

/** 在筛选展示区间前计算全部采样的比较基准，避免月初第一条丢失已知前值。 */
export function goldSampleChanges(points: HistoryPoint[]): GoldSampleChange[] {
  return [...points]
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((point, index, all) => {
      const previous = all[index - 1]
      if (!previous) return { ...point }
      return {
        ...point,
        previousDate: previous.date,
        changeAmount: money(new D(point.value).minus(previous.value)),
        changePercent: new D(previous.value).gt(0)
          ? new D(point.value).div(previous.value).minus(1).mul(100).toFixed(2)
          : undefined,
        gapDays: Math.round((Date.parse(point.date) - Date.parse(previous.date)) / 86400000),
      }
    })
}
