import Decimal from 'decimal.js'
export const D = Decimal.clone({ precision: 40, rounding: Decimal.ROUND_HALF_UP })

/** 金额、数量和价格在输入边界验证精度，不接受指数、NaN或静默截断。 */
export function decimalInput(value: string, label: string, places = 8, allowZero = false): Decimal {
  if (
    typeof value !== 'string' ||
    !/^\d+(?:\.\d+)?$/.test(value) ||
    (value.split('.')[1]?.length || 0) > places
  )
    throw new Error(`${label}格式不正确，最多${places}位小数`)
  const number = new D(value)
  if (number.gt('999999999999') || (allowZero ? number.lt(0) : number.lte(0)))
    throw new Error(`${label}必须${allowZero ? '不小于' : '大于'}0且在有效范围内`)
  return number
}
/** 显示金额到分；运算在调用方保持Decimal，避免二进制浮点结算。 */
export function money(value: Decimal.Value): string {
  return new D(value).toFixed(2)
}
/** 用于中国市场日期，不依赖设备或测试主机设置的时区。 */
export function today(): string {
  return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
}
/** 日期必须真实存在，不能晚于今天。 */
export function validDate(value: string): void {
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    Number.isNaN(Date.parse(value)) ||
    new Date(value).toISOString().slice(0, 10) !== value ||
    value > today()
  )
    throw new Error('请填写有效的成交/基准日期，不能晚于今天')
}
/** 格式化只用于呈现，不将带逗号的文本写回资金字段。 */
export function formatMoney(value: Decimal.Value, places = 2): string {
  const [whole, fraction] = new D(value).toFixed(places).split('.')
  return (
    whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (fraction === undefined ? '' : '.' + fraction)
  )
}
