import type { Book, Plan } from './book'
import { positionKey } from './book'
import { projectBook } from './ledger'
import type { History, HistoryPoint } from './market'
import { D } from './money'

/** 分段线与该日账本对应；未记录的参数或观察高点保持缺失，不反推历史信号。 */
export interface ChartReference {
  date: string
  cost?: string
  buy?: string
  sell?: string
}
/** 本机金价采样缺日必须断线；ETF/基金交易日历的正常休市不使用此规则。 */
export function startsHistorySegment(points: HistoryPoint[], index: number): boolean {
  if (index === 0) return true
  const point = points[index],
    previous = points[index - 1]
  return (
    !!point.sampledAt &&
    (!previous.sampledAt ||
      Date.parse(point.date.replace(' ', 'T') + (point.date.length > 10 ? ':00Z' : '')) -
        Date.parse(previous.date.replace(' ', 'T') + (previous.date.length > 10 ? ':00Z' : '')) >
        (point.date.length > 10 ? 120000 : 86400000))
  )
}

/** 重叠区间以本次来源修订值为准，旧覆盖保留；分钟序列由独立缓存直接替换，不经过日历史合并。 */
export function mergeHistory(previous: History | undefined, next: History): History {
  if (
    !previous ||
    previous.instrumentId !== next.instrumentId ||
    previous.resolution !== next.resolution
  )
    return next
  const rows = new Map(previous.points.map((p) => [p.date, p]))
  for (const point of next.points) rows.set(point.date, point)
  return { ...next, points: [...rows.values()].sort((a, b) => a.date.localeCompare(b.date)) }
}

/** 周/月K仅聚合完整来源日K，最后一根为截至当前的未结束周期，不生成缺失交易日。 */
export function aggregateCandles(
  points: HistoryPoint[],
  period: 'day' | 'week' | 'month',
): HistoryPoint[] {
  if (period === 'day') return points
  const groups = new Map<string, HistoryPoint>()
  for (const point of points) {
    if (!point.open || !point.high || !point.low) throw new Error('缺少日K开高低价，不能聚合')
    const date = new Date(point.date + 'T00:00:00Z')
    date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7))
    const key = period === 'month' ? point.date.slice(0, 7) : date.toISOString().slice(0, 10)
    const previous = groups.get(key)
    groups.set(
      key,
      previous
        ? {
            ...previous,
            date: point.date,
            value: point.value,
            high: D.max(previous.high!, point.high).toString(),
            low: D.min(previous.low!, point.low).toString(),
            volume: new D(previous.volume || 0).plus(point.volume || 0).toString(),
          }
        : { ...point, startDate: point.date },
    )
  }
  return [...groups.values()]
}

/** 历史成本从真实流水按日重放，买点参数仅使用当时已存在的历史快照。 */
export function chartReferences(
  book: Book,
  accountId: string,
  instrumentId: string,
  dates: string[],
  plan?: Plan,
): ChartReference[] {
  const eventDates = [...new Set(dates.map((date) => date.slice(0, 10)))]
  const history = [...(plan?.history || [])].sort((a, b) =>
    a.recordedAt.localeCompare(b.recordedAt),
  )
  return eventDates.map((date) => {
    const view: Book = {
      ...book,
      openings: book.openings.filter((row) => row.date <= date),
      trades: book.trades.filter((row) => row.date <= date),
      cashFlows: book.cashFlows.filter((row) => row.date <= date),
      corporateActions: (book.corporateActions || []).filter((row) => row.date <= date),
    }
    const derived = projectBook(view, date),
      position = derived.positions[positionKey(accountId, instrumentId)]
    const result: ChartReference = { date }
    if (position && new D(position.qty).gt(0)) result.cost = position.unitCost
    const events = history.filter(
      (event) =>
        new Date(Date.parse(event.recordedAt) + 8 * 3600000).toISOString().slice(0, 10) <= date,
    )
    const latest = events[events.length - 1],
      parameters = latest?.snapshot
    const state = plan && derived.plans[plan.id]
    if (parameters && state && !state.ended && !state.eventBlocked && !parameters.paused) {
      if (state.lastBuy)
        result.buy = new D(state.lastBuy)
          .mul(new D(1).minus(new D(parameters.drop).div(100)))
          .toString()
      if (parameters.observing && parameters.high)
        result.sell = new D(parameters.high)
          .mul(new D(1).minus(new D(parameters.retrace).div(100)))
          .toString()
    }
    return result
  })
}
