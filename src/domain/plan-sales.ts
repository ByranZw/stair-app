import type { Book, Projection } from './book'
import { D } from './money'

/** 本轮卖出汇总以每笔当时结转成本计算收益率，不以计划预算或现金转入作分母。 */
export function summarizePlanSales(book: Book, projection: Projection, planId: string) {
  const totals = book.trades
    .filter(
      (trade) => trade.planId === planId && trade.side === 'sell' && trade.status === 'confirmed',
    )
    .reduce(
      (sum, trade) => {
        const result = projection.trades[trade.id]
        return {
          net: sum.net.plus(result.net),
          pnl: sum.pnl.plus(result.realizedPnl || 0),
          cost: sum.cost.plus(result.costBasis || 0),
        }
      },
      { net: new D(0), pnl: new D(0), cost: new D(0) },
    )
  return { ...totals, pct: totals.cost.gt(0) ? totals.pnl.div(totals.cost).mul(100) : undefined }
}
