import type { Instrument, Quote } from './market'
import { D } from './money'

/** 旧标的没有币种时仍按人民币；股票币种由交易市场唯一确定。 */
export function currencyOf(item: Instrument): 'CNY' | 'HKD' | 'USD' {
  return item.market === 'hk' ? 'HKD' : item.market === 'us' ? 'USD' : 'CNY'
}
/** 海外成交的人民币资金以实际结算额为准，不用当前汇率回算历史现金。 */
export function isForeign(item: Instrument): boolean {
  return currencyOf(item) !== 'CNY'
}
/** 数量单位随标的类型展示，股票不再冒充基金份额。 */
export function instrumentUnit(item: Instrument): '克' | '股' | '份' {
  return item.type === 'GOLD' ? '克' : item.type === 'STOCK' ? '股' : '份'
}
/** 列表类别保留股票交易市场，避免同代码跨市场混淆。 */
export function instrumentLabel(item: Instrument): string {
  return item.type === 'GOLD'
    ? '积存金'
    : item.type === 'FUND'
      ? '场外基金'
      : item.type === 'ETF'
        ? 'ETF'
        : item.market === 'hk'
          ? '港股'
          : item.market === 'us'
            ? '美股'
            : 'A 股'
}
/** 股票身份带市场；允许美股代码中的点，旧基金与黄金身份保持不变。 */
export function validInstrument(item: Instrument): boolean {
  if (!item || typeof item.name !== 'string' || !item.name.trim() || item.name.length > 80)
    return false
  if (item.type === 'GOLD') return item.id === 'GOLD:CMB-GOLD' && item.code === 'CMB-GOLD'
  if (item.type === 'STOCK') {
    const code =
      item.market === 'hk'
        ? /^\d{5}$/.test(item.code)
        : item.market === 'us'
          ? /^[A-Z][A-Z0-9.-]{0,14}$/.test(item.code)
          : ['sh', 'sz', 'bj'].includes(item.market || '') && /^\d{6}$/.test(item.code)
    return (
      code && item.id === `STOCK:${item.market}:${item.code}` && item.currency === currencyOf(item)
    )
  }
  return (
    ['ETF', 'FUND'].includes(item.type) &&
    /^\d{6}$/.test(item.code) &&
    item.id === `${item.type}:${item.code}` &&
    (item.type !== 'ETF' || ['sh', 'sz'].includes(item.market || ''))
  )
}
/** 汇率须为正数并带报价日期；海外旧缓存缺失币种时从稳定身份识别。 */
export function quoteFx(quote: Quote): string | undefined {
  if (quote.currency === 'CNY') return '1'
  const foreign =
    quote.currency === 'HKD' ||
    quote.currency === 'USD' ||
    /^STOCK:(hk|us):/.test(quote.instrumentId)
  if (!foreign) return '1'
  if (
    !quote.fxRate ||
    !quote.fxDate ||
    !/^\d{4}-\d{2}-\d{2}(?: \d{2}:\d{2}:\d{2})?$/.test(quote.fxDate) ||
    Number.isNaN(Date.parse(quote.fxDate.slice(0, 10))) ||
    !/^\d+(?:\.\d+)?$/.test(quote.fxRate) ||
    !new D(quote.fxRate).gt(0)
  )
    return undefined
  return quote.fxRate
}
/** 行情原币价格仅在有有效汇率时参与人民币估值。 */
export function quoteCnyValue(quote: Quote, buy = false): string | undefined {
  const rate = quoteFx(quote)
  return rate
    ? new D(buy ? quote.buyValue || quote.value : quote.value).mul(rate).toString()
    : undefined
}
/** 策略及其历史快照统一保存人民币报价，与成本和预算使用同一单位。 */
export function quoteInCny(quote: Quote): Quote | undefined {
  const value = quoteCnyValue(quote)
  if (!value) return undefined
  return {
    ...quote,
    value,
    ...(quote.buyValue ? { buyValue: quoteCnyValue(quote, true) } : {}),
    currency: 'CNY',
    source:
      quote.currency !== 'CNY' && quote.fxRate ? `${quote.source} · 人民币折算` : quote.source,
  }
}
/** 图表以原币坐标呈现，人民币成本参考按当前汇率换算。 */
export function priceInCurrency(cny: string, quote?: Quote): string | undefined {
  if (!quote) return undefined
  const rate = quoteFx(quote)
  return rate ? new D(cny).div(rate).toString() : undefined
}
