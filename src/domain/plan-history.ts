import type { Plan, PlanEvent, PlanResult, PlanSnapshot, Position } from './book'
import type { Quote } from './market'
import { D, decimalInput, derivedPrice } from './money'

/** 复制参与决策的参数和状态，避免后来编辑或高点更新污染旧记录。 */
export function planSnapshot(plan: Plan): PlanSnapshot {
  const {
    budget,
    parts,
    drop,
    observe,
    retrace,
    version,
    initialLastBuy,
    paused,
    observing,
    high,
    signal,
    signalDate,
  } = plan
  return JSON.parse(
    JSON.stringify({
      budget,
      parts,
      drop,
      observe,
      retrace,
      version,
      initialLastBuy,
      paused,
      observing,
      high,
      signal,
      signalDate,
    }),
  )
}
/** 与计划实体同事务追加；调用方只记录实际发生的操作，不为旧数据补造创建事件。 */
export function appendPlanEvent(
  plan: Plan,
  event: Pick<PlanEvent, 'kind' | 'reason'> &
    Partial<Pick<PlanEvent, 'previous' | 'quote' | 'basis' | 'tradeId'>>,
  recordedAt = new Date().toISOString(),
): void {
  const history = plan.history || []
  plan.history = [
    ...history,
    {
      ...event,
      id: `${recordedAt}/${history.length + 1}`,
      recordedAt,
      snapshot: planSnapshot(plan),
    },
  ]
}
/** 只记录观察/高点/提醒发生的变化，重复报价与仅时间推进不刷屏。 */
export function recordQuoteHistory(
  previous: Plan,
  next: Plan,
  quote: Quote,
  result: PlanResult,
  position?: Position,
): Plan {
  const reasons: string[] = []
  if (!previous.observing && next.observing) reasons.push('达到观察收益率，开始跟踪采样高点')
  else if (next.high !== previous.high && next.high) reasons.push('更新实际采集高点')
  if (next.signal !== previous.signal) {
    reasons.push(
      next.signal === 'buy'
        ? '跌至加仓档位，只提醒投入一份'
        : next.signal === 'sell'
          ? '从采样高点回撤至止盈线，提醒清仓'
          : '加仓条件已不满足，撤回待执行提醒',
    )
  }
  if (!reasons.length) return next
  const basis: NonNullable<PlanEvent['basis']> = {
    used: result.used,
    reserved: result.reserved,
  }
  if (position && new D(position.qty).gt(0)) basis.unitCost = position.unitCost
  if (result.lastBuy) {
    basis.lastBuy = result.lastBuy
    basis.buyAt = new D(result.lastBuy).mul(new D(1).minus(new D(next.drop).div(100))).toString()
  }
  if (next.high)
    basis.sellAt = new D(next.high).mul(new D(1).minus(new D(next.retrace).div(100))).toString()
  appendPlanEvent(next, {
    kind: 'quote',
    reason: reasons.join('；'),
    previous: planSnapshot(previous),
    basis,
    quote: {
      value: quote.value,
      ...(quote.currency ? { currency: quote.currency } : {}),
      ...(quote.fxRate ? { fxRate: quote.fxRate } : {}),
      ...(quote.fxDate ? { fxDate: quote.fxDate } : {}),
      ...(quote.buyValue ? { buyValue: quote.buyValue } : {}),
      date: quote.date,
      source: quote.source,
      kind: quote.kind,
    },
  })
  return next
}
/** 历史是备份中的外部输入，校验结构与快照数值，旧计划缺省历史仍可正常读取。 */
export function validatePlanHistory(plan: Plan): void {
  if (plan.history === undefined) return
  if (!Array.isArray(plan.history)) throw new Error('计划历史格式无效')
  const ids = new Set<string>()
  for (const event of plan.history) {
    if (
      !event ||
      typeof event.id !== 'string' ||
      !event.id ||
      ids.has(event.id) ||
      typeof event.recordedAt !== 'string' ||
      Number.isNaN(Date.parse(event.recordedAt)) ||
      ![
        'created',
        'parameters',
        'paused',
        'resumed',
        'quote',
        'trade',
        'restored',
        'corporate-action',
        'opening',
      ].includes(event.kind) ||
      typeof event.reason !== 'string' ||
      !event.reason ||
      event.reason.length > 500
    )
      throw new Error('计划历史记录无效')
    ids.add(event.id)
    for (const snapshot of [event.snapshot, ...(event.previous ? [event.previous] : [])]) {
      if (
        !snapshot ||
        !Number.isInteger(snapshot.version) ||
        snapshot.version < 1 ||
        !Number.isInteger(snapshot.parts) ||
        snapshot.parts < 1 ||
        snapshot.parts > 1000 ||
        typeof snapshot.paused !== 'boolean' ||
        typeof snapshot.observing !== 'boolean' ||
        (snapshot.signal !== undefined && !['buy', 'sell'].includes(snapshot.signal))
      )
        throw new Error('计划历史快照无效')
      decimalInput(snapshot.budget, '历史预算', 2)
      for (const key of ['drop', 'retrace'] as const)
        if (decimalInput(snapshot[key], '历史跌幅', 4).gte(100)) throw new Error('历史跌幅无效')
      if (decimalInput(snapshot.observe, '历史观察收益率', 4).gt(10000))
        throw new Error('历史观察收益率无效')
      if (snapshot.initialLastBuy) derivedPrice(snapshot.initialLastBuy, '历史上次买价')
      if (snapshot.high) derivedPrice(snapshot.high, '历史采样高点')
    }
    if (event.quote) {
      derivedPrice(event.quote.value, '历史报价')
      if (event.quote.fxRate !== undefined) derivedPrice(event.quote.fxRate, '历史汇率')
      if (
        event.quote.fxDate !== undefined &&
        (typeof event.quote.fxDate !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(event.quote.fxDate))
      )
        throw new Error('历史汇率日期无效')
      if (
        event.quote.currency !== undefined &&
        !['CNY', 'HKD', 'USD'].includes(event.quote.currency)
      )
        throw new Error('历史币种无效')
      if (event.quote.buyValue !== undefined) derivedPrice(event.quote.buyValue, '历史客户买入价')
      if (
        typeof event.quote.date !== 'string' ||
        !event.quote.date ||
        typeof event.quote.source !== 'string' ||
        !event.quote.source ||
        !['market', 'nav'].includes(event.quote.kind)
      )
        throw new Error('历史行情来源无效')
    }
    if (event.basis) {
      decimalInput(event.basis.used, '历史已投', 2, true)
      decimalInput(event.basis.reserved, '历史预留', 2, true)
      for (const key of ['unitCost', 'lastBuy', 'buyAt', 'sellAt'] as const)
        if (event.basis[key] !== undefined) {
          const value = event.basis[key]!
          if (typeof value !== 'string' || !/^[0-9.e+-]+$/.test(value))
            throw new Error('历史参考价无效')
          const number = new D(value)
          if (!number.isFinite() || number.lt(0) || number.gt('1e40'))
            throw new Error('历史参考价无效')
        }
    }
    if (event.tradeId !== undefined && typeof event.tradeId !== 'string')
      throw new Error('历史成交关联无效')
  }
}
