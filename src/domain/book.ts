import type { Instrument } from './market'

/** 账户的现金基准明确到日，不能把当前余额与基准之前的交易重复相加。 */
export interface Account {
  id: string
  name: string
  openingCash: string
  date: string
}
/** 导入只建立当日数量与总成本，不伪造过去成交或从平均成本猜上次买价。 */
export interface OpeningPosition {
  id: string
  accountId: string
  instrumentId: string
  date: string
  qty: string
  totalCost: string
}
/** 已确认流水采用实际值；待确认仅预留资金或数量，不改变账本。 */
export interface Trade {
  id: string
  accountId: string
  instrumentId: string
  planId?: string
  side: 'buy' | 'sell'
  status: 'pending' | 'confirmed' | 'cancelled'
  date: string
  time: string
  sequence: number
  orderConfirmed: boolean
  qty: string
  price: string
  fee: string
  pendingAmount: string
  inputAmount?: string
  /** 黄金最后编辑的换算依据；重新打开更正时沿用。 */
  inputBasis?: '克' | '元'
  applicationDate?: string
  corrections?: TradeCorrection[]
}
/** 更正保留原成交值，便于核对重算前依据；历史快照不参与当前金额计算。 */
export interface TradeCorrection {
  recordedAt: string
  previous: Omit<Trade, 'corrections'>
}
/** 只记录实际资金转入转出，计划预算不计入现金。 */
export interface CashFlow {
  id: string
  accountId: string
  date: string
  amount: string
  side: 'in' | 'out'
  sequence: number
}
/** 每轮独立参数快照；跟踪字段记录实际采集高点，不补造未观察行情。 */
export interface Plan {
  id: string
  accountId: string
  instrumentId: string
  budget: string
  parts: number
  drop: string
  observe: string
  retrace: string
  version: number
  createdAt: string
  initialLastBuy?: string
  paused: boolean
  observing: boolean
  high?: string
  lastQuoteDate?: string
  signal?: 'buy' | 'sell'
  signalDate?: string
  history?: PlanEvent[]
}
/** 小规模个人账本按实体表一次事务提交；revision用于并发写入冲突检查。 */
export interface Book {
  schema: 1
  revision: number
  accounts: Account[]
  instruments: Instrument[]
  openings: OpeningPosition[]
  trades: Trade[]
  cashFlows: CashFlow[]
  plans: Plan[]
  corporateActions?: CorporateAction[]
}
/** 成交投影保存当时成本快照，用于历史卖出盈亏，不能回填当前均价。 */
export interface TradeResult {
  id: string
  gross: string
  net: string
  costBasis?: string
  unitCostBefore?: string
  realizedPnl?: string
  returnPct?: string
}
/** 持仓按账户与标的隔离；分摊成本保留十进制余数，展示时再舍入到分。 */
export interface Position {
  accountId: string
  instrumentId: string
  qty: string
  totalCost: string
  unitCost: string
  realizedPnl: string
}
/** 计划已投为本轮累计确认买入，卖出不回填预算；已结束轮次不自动重开。 */
export interface PlanResult {
  id: string
  used: string
  reserved: string
  lastBuy?: string
  ended: boolean
  eventBlocked?: boolean
}
/** 所有派生值都由同一账本重放，持仓、现金、成交结果不能各自独立增减。 */
export interface Projection {
  positions: Record<string, Position>
  cash: Record<string, string>
  availableCash: Record<string, string>
  trades: Record<string, TradeResult>
  plans: Record<string, PlanResult>
}

/** 空账本无示例资金，创建失败时不能被当作可写空数据库。 */
export function emptyBook(): Book {
  return {
    schema: 1,
    revision: 0,
    accounts: [],
    instruments: [],
    openings: [],
    trades: [],
    cashFlows: [],
    plans: [],
    corporateActions: [],
  }
}
/** 账户与标的共同确定成本归属，避免多账户同标的混算。 */
export function positionKey(accountId: string, instrumentId: string): string {
  return `${accountId}/${instrumentId}`
}

/** 事件只存当时参数和跟踪状态，不引用会变化的当前计划，也不递归保存历史。 */
export type PlanSnapshot = Pick<
  Plan,
  | 'budget'
  | 'parts'
  | 'drop'
  | 'observe'
  | 'retrace'
  | 'version'
  | 'initialLastBuy'
  | 'paused'
  | 'observing'
  | 'high'
  | 'signal'
  | 'signalDate'
>
/** 记录真实采集与用户操作；旧版本没有记录的历史不反向推造。 */
export interface PlanEvent {
  id: string
  recordedAt: string
  kind:
    | 'created'
    | 'parameters'
    | 'paused'
    | 'resumed'
    | 'quote'
    | 'trade'
    | 'restored'
    | 'corporate-action'
    | 'opening'
  reason: string
  snapshot: PlanSnapshot
  previous?: PlanSnapshot
  quote?: { value: string; buyValue?: string; date: string; source: string; kind: 'market' | 'nav' }
  basis?: {
    unitCost?: string
    lastBuy?: string
    buyAt?: string
    sellAt?: string
    used: string
    reserved: string
  }
  tradeId?: string
}

/** 分红与拆分按所属账户实际权益登记；生效日按开盘前处理，不能伪造普通买卖。 */
export interface CorporateAction {
  id: string
  accountId: string
  instrumentId: string
  date: string
  cashDate?: string
  type: 'dividend' | 'reinvest' | 'split'
  status: 'pending' | 'confirmed'
  referenceQty: string
  cashPerShare: string
  cashAmount: string
  ratio: string
  addedQty: string
  source: string
  orderConfirmed: boolean
}
