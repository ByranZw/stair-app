import { decimalInput, money } from './money'

/** 导入持仓在成本价和总成本之间换算；只将按分取整的总成本交给账本，保留反算单价精度。 */
export function openingCost(qty: string, value: string, basis: 'unit' | 'total') {
  const quantity = decimalInput(qty, '持仓数量')
  const cost = decimalInput(
    value,
    basis === 'unit' ? '持仓成本价' : '持仓总成本',
    basis === 'unit' ? 40 : 2,
  )
  const totalCost = basis === 'unit' ? money(quantity.mul(cost)) : money(cost)
  decimalInput(totalCost, '持仓总成本', 2)
  // 数量上限为万亿，保留28位小数足以保持按分总成本；固定小数避免反算结果出现指数格式。
  return {
    totalCost,
    unitCost: basis === 'unit' ? cost.toFixed() : cost.div(quantity).toDecimalPlaces(28).toFixed(),
  }
}
