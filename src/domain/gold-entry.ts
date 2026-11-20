import { D, decimalInput, money } from './money'

/** 克元联动使用实际单价；8位仅为本应用录入上限，换算克重仍需按银行确认结果核对。 */
export function convertGold(value: string, price: string, basis: '克' | '元'): string {
  const amount = decimalInput(value, basis === '克' ? '克重' : '不含费金额', basis === '克' ? 8 : 2)
  const unit = decimalInput(price, '实际单价')
  return basis === '克'
    ? money(amount.mul(unit))
    : new D(amount).div(unit).toDecimalPlaces(8).toString()
}
