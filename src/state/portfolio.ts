import { computed } from 'vue'
import { bookState, projection, selectedAccountId } from './book'
import { watchState } from './watchlist'
import { D } from '../domain/money'
/** 首页汇总按账户筛选；没有可信价格的资产单列，不用成本冒充市值。 */
export const portfolio = computed(() => {
  const accounts = bookState.data.accounts.filter(
    (a) => !selectedAccountId.value || a.id === selectedAccountId.value,
  )
  const rows = Object.values(projection.value.positions)
    .filter((p) => new D(p.qty).gt(0) && accounts.some((a) => a.id === p.accountId))
    .map((position) => {
      const item = bookState.data.instruments.find((i) => i.id === position.instrumentId)!
      const cached = watchState.cache[item.id]
      const value = cached ? new D(cached.quote.value).mul(position.qty) : undefined
      const pnl = value?.minus(position.totalCost)
      return { ...position, item, value, pnl, stale: !!watchState.errors[item.id] }
    })
  const cash = accounts.reduce((sum, a) => sum.plus(projection.value.cash[a.id]), new D(0))
  const available = accounts.reduce(
    (sum, a) => sum.plus(projection.value.availableCash[a.id]),
    new D(0),
  )
  const market = rows.reduce((sum, p) => sum.plus(p.value || 0), new D(0))
  const pnl = rows.reduce((sum, p) => sum.plus(p.pnl || 0), new D(0))
  const pricedCost = rows
    .filter((p) => p.value !== undefined)
    .reduce((sum, p) => sum.plus(p.totalCost), new D(0))
  // 清仓后的持仓投影仍保留已实现收益；分红也由账本记入同一口径，不能只加卖出交易。
  const realized = Object.values(projection.value.positions)
    .filter((p) => accounts.some((a) => a.id === p.accountId))
    .reduce((sum, p) => sum.plus(p.realizedPnl), new D(0))
  return {
    realized,
    totalPnl: realized.plus(pnl),
    rows,
    cash,
    available,
    assets: cash.plus(market),
    pnl,
    pct: pricedCost.gt(0) ? pnl.div(pricedCost).mul(100) : undefined,
    unpriced: rows.filter((p) => !p.value).length,
  }
})
