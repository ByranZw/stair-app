import type { Book, CashFlow, OpeningPosition } from './book'
import { positionKey } from './book'
import { projectBook } from './ledger'
import { appendPlanEvent, planSnapshot } from './plan-history'

/** 更正或删除初始持仓，完整重放后才返回新账本，失败不修改原始数据。 */
export function maintainOpening(
  book: Book,
  id: string,
  input: Omit<OpeningPosition, 'id'> | null,
  baseline?: OpeningPosition,
): Book {
  const old = book.openings.find((row) => row.id === id)
  if (!old) throw new Error('这笔初始持仓已删除，请重新打开')
  if (baseline && JSON.stringify(old) !== JSON.stringify(baseline))
    throw new Error('这笔初始持仓已修改，请重新打开')
  if (
    input &&
    Object.entries(input).every(([key, value]) => old[key as keyof OpeningPosition] === value)
  )
    return book
  const next: Book = JSON.parse(JSON.stringify(book))
  next.openings = input
    ? next.openings.map((row) => (row.id === id ? { ...input, id } : row))
    : next.openings.filter((row) => row.id !== id)
  const affected = new Set([
    positionKey(old.accountId, old.instrumentId),
    ...(input ? [positionKey(input.accountId, input.instrumentId)] : []),
  ])
  for (const plan of next.plans) {
    if (!affected.has(positionKey(plan.accountId, plan.instrumentId))) continue
    const previous = planSnapshot(plan)
    plan.observing = false
    delete plan.high
    delete plan.signal
    delete plan.signalDate
    delete plan.lastQuoteDate
    delete plan.lastFxDate
    appendPlanEvent(plan, {
      kind: 'opening',
      previous,
      reason: input ? '修改初始持仓，重新跟踪行情' : '删除初始持仓，重新跟踪行情',
    })
  }
  projectBook(next)
  return next
}

/** 资金流水更正保留原序号；按事实重放，现金缺口不阻止更正或删除。 */
export function maintainCashFlow(
  book: Book,
  id: string,
  input: Omit<CashFlow, 'id' | 'sequence'> | null,
  baseline?: CashFlow,
): Book {
  const old = book.cashFlows.find((row) => row.id === id)
  if (!old) throw new Error('这笔资金流水已删除，请重新打开')
  if (baseline && JSON.stringify(old) !== JSON.stringify(baseline))
    throw new Error('这笔资金流水已修改，请重新打开')
  if (input && Object.entries(input).every(([key, value]) => old[key as keyof CashFlow] === value))
    return book
  const next: Book = JSON.parse(JSON.stringify(book))
  next.cashFlows = input
    ? next.cashFlows.map((row) => (row.id === id ? { ...input, id, sequence: old.sequence } : row))
    : next.cashFlows.filter((row) => row.id !== id)
  projectBook(next)
  return next
}
