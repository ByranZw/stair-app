import type { Book, Projection } from './book'
import { D, money } from './money'

/** 计划资金视图使用本轮累计买入，不把持仓市值或卖出回款当作预算消耗。 */
export interface PlanCapital {
  planId: string
  accountId: string
  instrumentId: string
  budget: string
  parts: number
  perPart: string
  used: string
  pending: string
  remaining: string
  ended: boolean
  paused: boolean
}

/** 软预留只影响规划展示；自由资金可以为负，保留真实预算缺口。 */
export interface CapitalSummary {
  cash: string
  available: string
  pending: string
  budget: string
  used: string
  planPending: string
  remaining: string
  free: string
  plans: PlanCapital[]
  accounts: AccountCapital[]
  shortfall: string
}

/** 账户资金不自动互转；总览合计为正时仍需揭示某个账户的预算缺口。 */
export interface AccountCapital {
  accountId: string
  name: string
  cash: string
  available: string
  remaining: string
  free: string
}

/** 按当前账户筛选复用已验证投影；暂停保留预留，结束轮次只留明细不占用资金。 */
export function summarizeCapital(
  book: Book,
  projection: Projection,
  accountId = '',
): CapitalSummary {
  const accounts = book.accounts.filter((account) => !accountId || account.id === accountId)
  const ids = new Set(accounts.map((account) => account.id))
  const plans = book.plans
    .filter((plan) => ids.has(plan.accountId))
    .map((plan): PlanCapital => {
      const derived = projection.plans[plan.id]
      return {
        planId: plan.id,
        accountId: plan.accountId,
        instrumentId: plan.instrumentId,
        budget: money(plan.budget),
        parts: plan.parts,
        perPart: money(new D(plan.budget).div(plan.parts)),
        used: money(derived.used),
        pending: money(derived.reserved),
        remaining: derived.ended
          ? '0.00'
          : money(D.max(new D(plan.budget).minus(derived.used).minus(derived.reserved), 0)),
        ended: derived.ended,
        paused: plan.paused,
      }
    })
  const cash = accounts.reduce((sum, account) => sum.plus(projection.cash[account.id]), new D(0))
  const available = accounts.reduce(
    (sum, account) => sum.plus(projection.availableCash[account.id]),
    new D(0),
  )
  const active = plans.filter((plan) => !plan.ended)
  const budget = active.reduce((sum, plan) => sum.plus(plan.budget), new D(0))
  const used = active.reduce((sum, plan) => sum.plus(plan.used), new D(0))
  const planPending = active.reduce((sum, plan) => sum.plus(plan.pending), new D(0))
  const remaining = active.reduce((sum, plan) => sum.plus(plan.remaining), new D(0))
  const accountCapital = accounts.map((account): AccountCapital => {
    const planned = active
      .filter((plan) => plan.accountId === account.id)
      .reduce((sum, plan) => sum.plus(plan.remaining), new D(0))
    return {
      accountId: account.id,
      name: account.name,
      cash: money(projection.cash[account.id]),
      available: money(projection.availableCash[account.id]),
      remaining: money(planned),
      free: money(new D(projection.availableCash[account.id]).minus(planned)),
    }
  })
  return {
    cash: money(cash),
    available: money(available),
    pending: money(cash.minus(available)),
    budget: money(budget),
    used: money(used),
    planPending: money(planPending),
    remaining: money(remaining),
    free: money(available.minus(remaining)),
    plans,
    accounts: accountCapital,
    shortfall: money(
      accountCapital.reduce(
        (sum, account) => sum.plus(D.max(new D(account.free).negated(), 0)),
        new D(0),
      ),
    ),
  }
}
