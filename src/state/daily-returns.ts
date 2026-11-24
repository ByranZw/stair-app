import { computed } from 'vue'
import { positionKey, type Projection } from '../domain/book'
import { projectBook } from '../domain/ledger'
import { positionDailyReturn, quoteDailyChange, type DailyReturn } from '../domain/daily-returns'
import { D } from '../domain/money'
import { bookState, projection } from './book'
import { watchState } from './watchlist'

/** 同一报价日只重放一次昨日日终账本，不把当前数量直接乘整日涨幅。 */
export const positionReturns = computed(() => {
  const previousDays = new Map<string, Projection>()
  const results: Record<string, DailyReturn> = {}
  for (const position of Object.values(projection.value.positions)) {
    const cache = watchState.cache[position.instrumentId]
    const day = cache?.quote.date.slice(0, 10)
    let previous: Projection | undefined
    if (day && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day))) {
      if (!previousDays.has(day)) {
        const yesterday = new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10)
        previousDays.set(day, projectBook(bookState.data, yesterday))
      }
      previous = previousDays.get(day)
    }
    const key = positionKey(position.accountId, position.instrumentId)
    results[key] = positionDailyReturn(
      bookState.data,
      projection.value,
      position,
      previous?.positions[key],
      cache?.quote,
      cache?.history,
    )
  }
  return results
})

/** 自选的个人日收益汇总全部账户；任一相关账户缺少基准时不把部分值当完整收益。 */
export const watchReturns = computed(() => {
  const results: Record<string, DailyReturn> = {}
  for (const item of watchState.items) {
    const quote = watchState.cache[item.id]?.quote
    const related = Object.values(projection.value.positions)
      .filter(
        (position) =>
          position.instrumentId === item.id &&
          (new D(position.qty).gt(0) ||
            bookState.data.trades.some(
              (trade) =>
                trade.accountId === position.accountId &&
                trade.instrumentId === item.id &&
                trade.status === 'confirmed' &&
                trade.date === quote?.date.slice(0, 10),
            )),
      )
      .map((position) => positionReturns.value[positionKey(position.accountId, item.id)])
    results[item.id] = {
      date: quote?.date.slice(0, 10),
      changePct: quoteDailyChange(quote),
      held: related.some((daily) => daily.held),
      estimated: related.some((daily) => daily.estimated),
      profit:
        related.length && related.every((daily) => daily.profit !== undefined)
          ? related.reduce((sum, daily) => sum.plus(daily.profit!), new D(0))
          : undefined,
    }
  }
  return results
})
