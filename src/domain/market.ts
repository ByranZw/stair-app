/** 标的身份独立于账户；招行黄金账户使用专用代码，不能混入纸黄金或上金所合约。 */
export interface Instrument {
  id: string
  code: string
  name: string
  type: 'ETF' | 'FUND' | 'GOLD' | 'STOCK'
  market?: 'sh' | 'sz' | 'bj' | 'hk' | 'us'
  currency?: 'CNY' | 'HKD' | 'USD'
}
/** 价格保留供应方十进制文本，显示涨跌不参与账本结算。 */
export interface Quote {
  instrumentId: string
  value: string
  currency?: 'CNY' | 'HKD' | 'USD'
  fxRate?: string
  fxDate?: string
  fxSource?: string
  delayed?: boolean
  previous?: string
  date: string
  source: string
  fetchedAt: string
  kind: 'market' | 'nav'
  corporateAction?: boolean
  buyValue?: string
  tradable?: boolean
  actions?: CorporateHint[]
}
/** 公开权益公告仅作为待核对提示，不代表本账户已经收到现金或份额。 */
export interface CorporateHint {
  date: string
  type: 'dividend' | 'split'
  cashPerShare: string
  ratio: string
  registrationDate?: string
  paymentDate?: string
  source: string
}
/** 历史点为正式净值或未复权收盘价，不是实际成交。 */
export interface HistoryPoint {
  date: string
  value: string
  open?: string
  high?: string
  low?: string
  volume?: string
  startDate?: string
  buyValue?: string
  sampledAt?: string
}
/** 历史仅声称返回的实际覆盖，不推断缺失区间。 */
export interface History {
  instrumentId: string
  points: HistoryPoint[]
  source: string
  fetchedAt: string
  resolution?: 'day' | 'minute'
}
/** 网络层只接受预定义来源，防止把开发代理当任意URL转发器。 */
export type Provider =
  'tencent' | 'fund-search' | 'fund-nav' | 'fund-actions' | 'cmb' | 'sge' | 'stock-search' | 'fx'
