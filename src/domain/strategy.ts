import type { Plan, PlanResult, Position, Trade } from './book'
import { D } from './money'
import type { Quote } from './market'

/** 与既有策略一致：请求15分钟内、市场日期不超过7天；以中国市场日判断。 */
export function isStrategyQuoteFresh(quote: Quote, now = Date.now()): boolean {
  const fresh = now - Date.parse(quote.fetchedAt)
  const marketDate = new Date(now + 8 * 3600000).toISOString().slice(0, 10)
  const marketAge = Date.parse(marketDate) - Date.parse(quote.date.slice(0, 10))
  return fresh >= 0 && fresh < 900000 && marketAge >= 0 && marketAge <= 7 * 86400000
}

/** 每次只处理新鲜、已核验的报价；不把缓存、候选黄金或提醒当实际成交。 */
export function evaluatePlan(
  plan: Plan,
  result: PlanResult,
  position: Position | undefined,
  trades: Trade[],
  quote: Quote,
  eligible: boolean,
): Plan {
  if (
    !eligible ||
    result.ended ||
    result.eventBlocked ||
    plan.paused ||
    quote.instrumentId !== plan.instrumentId ||
    quote.corporateAction ||
    quote.tradable === false ||
    new D(quote.value).lte(0)
  )
    return { ...plan }
  if (plan.lastQuoteDate && quote.date <= plan.lastQuoteDate) return { ...plan }
  const next = { ...plan, lastQuoteDate: quote.date }
  if (next.signal === 'sell') return next
  const pending = trades.some((t) => t.planId === plan.id && t.status === 'pending')
  const unitBudget = new D(plan.budget).div(plan.parts).toDecimalPlaces(2)
  const remaining = new D(plan.budget).minus(result.used).minus(result.reserved)
  if (new D(position?.qty || 0).gt(0) && new D(position!.unitCost).gt(0)) {
    const observation = new D(position!.unitCost).mul(new D(1).plus(new D(plan.observe).div(100)))
    if (!next.observing && new D(quote.value).gte(observation)) {
      next.observing = true
      next.high = quote.value
    }
    if (next.observing) {
      if (!next.high || new D(quote.value).gt(next.high)) next.high = quote.value
      if (
        new D(quote.value).lte(new D(next.high!).mul(new D(1).minus(new D(plan.retrace).div(100))))
      ) {
        next.signal = 'sell'
        next.signalDate = quote.date
        return next
      }
    }
  }
  if (
    !pending &&
    remaining.gte(unitBudget) &&
    unitBudget.gt(0) &&
    result.lastBuy &&
    new D(quote.buyValue || quote.value).lte(
      new D(result.lastBuy).mul(new D(1).minus(new D(plan.drop).div(100))),
    )
  ) {
    // 同一轮持续满足条件时保留首次触发时点，反弹撤回后再次触发才记新时间。
    if (next.signal !== 'buy') next.signalDate = quote.date
    next.signal = 'buy'
  } else if (next.signal === 'buy') {
    delete next.signal
    delete next.signalDate
  }
  return next
}
