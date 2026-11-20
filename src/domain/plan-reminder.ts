import type { Plan, PlanResult, Position, Trade } from './book'
import type { Quote } from './market'
import { D, formatMoney } from './money'
import { isStrategyQuoteFresh } from './strategy'

/** 提醒只是账本状态的展示投影；待核验信号不作为当前可执行建议。 */
export interface PlanReminder {
  planId: string
  kind:
    'buy' | 'sell' | 'observe' | 'waiting' | 'verify' | 'pending' | 'paused' | 'blocked' | 'ended'
  title: string
  message: string
  attention: boolean
  actionable: boolean
  signalDate?: string
  quoteDate?: string
  quoteSource?: string
  quoteValue?: string
  priceLabel?: string
  threshold?: string
  thresholdLabel?: string
}
/** 复用策略已保存的信号和真实报价，展示不能生成信号或改变计划高点。 */
export function describePlanReminder(
  plan: Plan,
  result: PlanResult,
  position: Position | undefined,
  trades: Trade[],
  quote: Quote | undefined,
  sourceError: string | undefined,
  now = Date.now(),
): PlanReminder {
  const reminder: PlanReminder = {
    planId: plan.id,
    kind: 'waiting',
    title: '跟踪中',
    message: '',
    attention: false,
    actionable: false,
    signalDate: plan.signalDate,
    quoteDate: quote?.date,
    quoteSource: quote?.source,
    priceLabel: quote?.fxRate
      ? '人民币折算价'
      : quote?.buyValue
        ? plan.signal === 'buy'
          ? '客户买入价'
          : '客户卖出价'
        : quote?.kind === 'nav'
          ? '正式净值'
          : '市场价',
    quoteValue: quote
      ? plan.signal === 'buy'
        ? quote.buyValue || quote.value
        : quote.value
      : undefined,
  }
  if (result.ended) return { ...reminder, kind: 'ended', title: '本轮结束' }
  if (result.eventBlocked || quote?.corporateAction)
    return {
      ...reminder,
      kind: 'blocked',
      title: '权益待核对',
      message: '查看权益事件',
      attention: true,
    }
  if (plan.paused) return { ...reminder, kind: 'paused', title: '已暂停', message: '' }
  if (trades.some((t) => t.planId === plan.id && t.status === 'pending'))
    return {
      ...reminder,
      kind: 'pending',
      title: '申请待确认',
      message: '',
      attention: true,
    }
  if ((plan.signal === 'sell' || (plan.observing && plan.signal !== 'buy')) && plan.high) {
    reminder.thresholdLabel = '回撤止盈价'
    reminder.threshold = new D(plan.high)
      .mul(new D(1).minus(new D(plan.retrace).div(100)))
      .toString()
  } else if (result.lastBuy) {
    reminder.thresholdLabel = '加仓参考价'
    reminder.threshold = new D(result.lastBuy)
      .mul(new D(1).minus(new D(plan.drop).div(100)))
      .toString()
  }
  if (
    !quote ||
    sourceError ||
    !isStrategyQuoteFresh(quote, now) ||
    quote.tradable === false ||
    plan.lastQuoteDate !== quote.date ||
    (!!(quote.fxDate || plan.lastFxDate) && plan.lastFxDate !== quote.fxDate)
  )
    return {
      ...reminder,
      kind: 'verify',
      title: '行情待更新',
      message: '',
      attention: false,
    }
  if (plan.signal) {
    const buy = plan.signal === 'buy'
    return {
      ...reminder,
      kind: plan.signal,
      title: buy ? '可加仓' : '可止盈',
      attention: true,
      actionable: true,
      message: buy
        ? `本次一份 ¥${formatMoney(new D(plan.budget).div(plan.parts))}`
        : '已达到回撤止盈价',
    }
  }
  if (plan.observing && plan.high)
    return {
      ...reminder,
      kind: 'observe',
      title: '止盈观察中',
      attention: false,
      threshold: new D(plan.high).mul(new D(1).minus(new D(plan.retrace).div(100))).toString(),
      message: '',
    }
  const remaining = new D(plan.budget).minus(result.used).minus(result.reserved)
  if (remaining.lt(new D(plan.budget).div(plan.parts).toDecimalPlaces(2)))
    reminder.message = '预算已用完'
  else if (!result.lastBuy) reminder.title = '待建仓'
  else reminder.message = `下一加仓价 ${formatMoney(reminder.threshold!, 4)}`
  return reminder
}
