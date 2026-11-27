import { validInstrument, isForeign } from './currency'
import type { Instrument } from './market'
import type { Account, Book, CorporateAction, Plan, Projection, Trade } from './book'
import { positionKey } from './book'
import { appendPlanEvent, planSnapshot, validatePlanHistory } from './plan-history'
import { D, decimalInput, derivedPrice, money, validDate } from './money'

/** 更正基准后完整重放历史；不生成虚假转入，校验失败绝不修改调用方账本。 */
export function correctAccount(
  book: Book,
  accountId: string,
  input: Pick<Account, 'name' | 'openingCash' | 'date'>,
  baseline?: Pick<Account, 'name' | 'openingCash' | 'date'>,
): Book {
  const current = book.accounts.find((row) => row.id === accountId)
  if (
    baseline &&
    (!current ||
      current.name !== baseline.name ||
      current.openingCash !== baseline.openingCash ||
      current.date !== baseline.date)
  )
    throw new Error('账户已更新，请载入最新账户后修改')
  const changed: Book = JSON.parse(JSON.stringify(book))
  const account = changed.accounts.find((row) => row.id === accountId)
  if (!account) throw new Error('账户不存在，请重新选择')
  const name = input.name.trim()
  if (changed.accounts.some((row) => row.id !== accountId && row.name.trim() === name))
    throw new Error('账户名称已存在')
  Object.assign(account, { name, openingCash: input.openingCash, date: input.date })
  projectBook(changed)
  return changed
}

/** 任何存储恢复和写入都先核对实体、引用与金额；失败不能变成空账本覆盖原数据。 */
export function validateBook(book: Book): void {
  if (!book || book.schema !== 1 || !Number.isInteger(book.revision) || book.revision < 0)
    throw new Error('账本版本不支持，请保留原数据')
  for (const rows of [
    book.accounts,
    book.instruments,
    book.openings,
    book.trades,
    book.cashFlows,
    book.plans,
    book.corporateActions || [],
  ]) {
    if (!Array.isArray(rows)) throw new Error('账本结构不完整')
    const ids = new Set<string>()
    for (const row of rows) {
      if (
        !row ||
        typeof row.id !== 'string' ||
        !row.id ||
        !/^[A-Za-z0-9][A-Za-z0-9:_.-]{0,99}$/.test(row.id) ||
        row.id in Object.prototype ||
        ids.has(row.id)
      )
        throw new Error('账本存在缺失或重复标识')
      ids.add(row.id)
    }
  }
  for (const account of book.accounts) {
    if (typeof account.name !== 'string' || !account.name.trim() || account.name.length > 30)
      throw new Error('账户名称为1至30字')
    decimalInput(account.openingCash, '初始现金', 2, true)
    validDate(account.date)
  }
  for (const item of book.instruments) {
    if (!validInstrument(item)) throw new Error('标的身份或市场代码无效')
  }
  for (const row of [
    ...book.openings,
    ...book.trades,
    ...book.plans,
    ...(book.corporateActions || []),
  ]) {
    if (
      !book.accounts.some((a) => a.id === row.accountId) ||
      !book.instruments.some((i) => i.id === row.instrumentId)
    )
      throw new Error('流水或计划所属账户/标的不存在')
  }
  const openingKeys = new Set<string>()
  for (const opening of book.openings) {
    validDate(opening.date)
    decimalInput(opening.qty, '导入数量')
    decimalInput(opening.totalCost, '导入总成本', 2)
    const key = positionKey(opening.accountId, opening.instrumentId)
    if (openingKeys.has(key)) throw new Error('同账户标的只允许一个导入基准，请勿重复导入')
    openingKeys.add(key)
    if (opening.date < book.accounts.find((a) => a.id === opening.accountId)!.date)
      throw new Error('导入日期不能早于账户现金基准')
  }
  for (const action of book.corporateActions || []) {
    validDate(action.date)
    if (
      !['dividend', 'reinvest', 'split'].includes(action.type) ||
      !['pending', 'confirmed'].includes(action.status) ||
      typeof action.orderConfirmed !== 'boolean' ||
      typeof action.source !== 'string' ||
      !action.source.trim() ||
      action.source.length > 200
    )
      throw new Error('分红拆分类型、状态或核对来源无效')
    if (book.instruments.find((i) => i.id === action.instrumentId)!.type === 'GOLD')
      throw new Error('积存金不使用基金分红拆分事件')
    const opening = book.openings.find(
      (o) => o.accountId === action.accountId && o.instrumentId === action.instrumentId,
    )
    if (
      action.date < book.accounts.find((a) => a.id === action.accountId)!.date ||
      (opening && action.date <= opening.date)
    )
      throw new Error('权益事件须在账户基准及持仓导入之后')
    if (
      (book.corporateActions || []).some(
        (other) =>
          other.id !== action.id &&
          other.accountId === action.accountId &&
          other.instrumentId === action.instrumentId &&
          other.date === action.date,
      )
    )
      throw new Error('同账户标的同日只登记一条权益事件，请核对是否重复')
    if (action.status === 'pending') continue
    if (action.cashDate) {
      validDate(action.cashDate)
      if (action.cashDate < action.date) throw new Error('权益到账日期不能早于除息生效日')
    }
    decimalInput(action.referenceQty, '权益份额')
    if (action.type === 'split') decimalInput(action.ratio, '拆分后份额倍数')
    else {
      decimalInput(action.cashPerShare, '每份分红')
      decimalInput(
        action.cashAmount,
        action.type === 'reinvest' ? '再投确认金额' : '实际到账分红',
        2,
        true,
      )
      if (action.type === 'reinvest') decimalInput(action.addedQty, '再投确认份额')
    }
    if (!action.orderConfirmed) throw new Error('请确认权益事件按生效日开盘前计算')
  }
  for (const plan of book.plans) validatePlan(plan)
  for (const trade of book.trades) {
    if (trade.corrections !== undefined) {
      if (!Array.isArray(trade.corrections)) throw new Error('成交更正历史格式无效')
      for (const correction of trade.corrections) {
        const previous = correction?.previous
        if (
          !correction ||
          typeof correction.recordedAt !== 'string' ||
          Number.isNaN(Date.parse(correction.recordedAt)) ||
          !previous ||
          previous.id !== trade.id ||
          previous.status !== 'confirmed' ||
          typeof previous.accountId !== 'string' ||
          typeof previous.instrumentId !== 'string' ||
          !['buy', 'sell'].includes(previous.side)
        )
          throw new Error('成交更正历史格式无效')
        validDate(previous.date)
        decimalInput(previous.qty, '原成交数量')
        decimalInput(previous.price, '原成交单价')
        decimalInput(previous.fee, '原手续费', 2, true)
        const originalItem = book.instruments.find((item) => item.id === previous.instrumentId)
        if (!originalItem) throw new Error('原成交标的不存在')
        validateSettlement(previous, originalItem)
      }
    }
    if (
      typeof trade.qty !== 'string' ||
      typeof trade.price !== 'string' ||
      typeof trade.pendingAmount !== 'string'
    )
      throw new Error('交易数量、单价或申请金额格式无效')
    validDate(trade.date)
    if (trade.applicationDate) {
      validDate(trade.applicationDate)
      if (trade.applicationDate > trade.date) throw new Error('正式确认日期不能早于申请日')
    }
    if (
      !['buy', 'sell'].includes(trade.side) ||
      !['pending', 'confirmed', 'cancelled'].includes(trade.status) ||
      !Number.isInteger(trade.sequence) ||
      typeof trade.orderConfirmed !== 'boolean' ||
      typeof trade.time !== 'string' ||
      (trade.time && !/^([01]\d|2[0-3]):[0-5]\d$/.test(trade.time))
    )
      throw new Error('交易状态或顺序格式无效')
    decimalInput(trade.fee, '手续费', 2, true)
    if (trade.status === 'confirmed') {
      decimalInput(trade.qty, '成交数量')
      decimalInput(trade.price, '成交单价')
      validateSettlement(
        trade,
        book.instruments.find((item) => item.id === trade.instrumentId)!,
      )
    }
    if (trade.status === 'pending') {
      if (book.instruments.find((i) => i.id === trade.instrumentId)!.type !== 'FUND')
        throw new Error('待确认申赎仅用于场外基金')
      if (trade.side === 'buy') decimalInput(trade.pendingAmount, '申请金额', 2)
      else decimalInput(trade.qty, '申请赎回份额')
    }
    if (trade.date < book.accounts.find((a) => a.id === trade.accountId)!.date)
      throw new Error('成交日期早于账户现金基准，请先核对初始现金')
    const opening = book.openings.find(
      (o) => o.accountId === trade.accountId && o.instrumentId === trade.instrumentId,
    )
    if (opening && trade.date < opening.date)
      throw new Error(
        `成交日期早于导入基准：${trade.date} ${book.instruments.find((i) => i.id === trade.instrumentId)!.name}，请将基准日期设在该笔成交之前`,
      )
    if (trade.planId) {
      const plan = book.plans.find((p) => p.id === trade.planId)
      if (!plan || plan.accountId !== trade.accountId || plan.instrumentId !== trade.instrumentId)
        throw new Error('成交不能关联其他账户或标的的计划')
    }
  }
  for (const flow of book.cashFlows) {
    const account = book.accounts.find((a) => a.id === flow.accountId)
    if (!account || !['in', 'out'].includes(flow.side) || !Number.isInteger(flow.sequence))
      throw new Error('资金流水所属账户或方向无效')
    validDate(flow.date)
    decimalInput(flow.amount, '转入/转出金额', 2)
    if (flow.date < account.date) throw new Error('资金日期早于账户基准')
  }
}

/** 参数仅影响本计划快照，比例上下限防止零档位和无穷触发。 */
export function validatePlan(plan: Plan): void {
  validatePlanHistory(plan)
  if (typeof plan.createdAt !== 'string' || Number.isNaN(Date.parse(plan.createdAt)))
    throw new Error('计划创建时间无效')
  if (plan.signal !== undefined && !['buy', 'sell'].includes(plan.signal))
    throw new Error('计划提醒类型无效')
  if (plan.lastQuoteDate !== undefined && typeof plan.lastQuoteDate !== 'string')
    throw new Error('计划行情日期无效')
  if (plan.lastFxDate !== undefined && typeof plan.lastFxDate !== 'string')
    throw new Error('计划汇率日期无效')
  if (plan.signalDate !== undefined && typeof plan.signalDate !== 'string')
    throw new Error('计划提醒日期无效')
  decimalInput(plan.budget, '计划预算', 2)
  if (!Number.isInteger(plan.parts) || plan.parts < 1 || plan.parts > 1000)
    throw new Error('资金份数为1至1000的整数')
  for (const field of ['drop', 'retrace'] as const)
    if (decimalInput(plan[field], '策略跌幅', 4).gte(100))
      throw new Error('加仓跌幅与回撤比例须小于100%')
  if (decimalInput(plan.observe, '观察收益率', 4).gt(10000))
    throw new Error('观察收益率超出有效范围')
  if (plan.initialLastBuy) derivedPrice(plan.initialLastBuy, '上次实际买入价')
  if (plan.high) derivedPrice(plan.high, '已采集高点')
  if (
    !Number.isInteger(plan.version) ||
    plan.version < 1 ||
    typeof plan.paused !== 'boolean' ||
    typeof plan.observing !== 'boolean'
  )
    throw new Error('计划参数版本无效')
}

/** 按已录事实重放持仓、现金和盈利；现金可为负，不以验资或预算阻拦补记。图表不提前计入权益。 */
export function projectBook(book: Book, throughDate?: string): Projection {
  validateBook(book)
  const result: Projection = { positions: {}, cash: {}, availableCash: {}, trades: {}, plans: {} }
  for (const account of book.accounts) result.cash[account.id] = money(account.openingCash)
  for (const plan of book.plans)
    result.plans[plan.id] = {
      id: plan.id,
      used: '0.00',
      reserved: '0.00',
      lastBuy: plan.initialLastBuy,
      ended: false,
    }
  const confirmed = book.trades.filter((t) => t.status === 'confirmed')
  const dateOrder = new Set<string>()
  for (const trade of confirmed) {
    const group = confirmed.filter((t) => t.accountId === trade.accountId && t.date === trade.date)
    if (group.length > 1 && group.some((t) => !t.time)) {
      if (group.some((t) => !t.orderConfirmed))
        throw new Error('同一账户同日有未填写时间的成交，请确认按记录顺序重放')
      dateOrder.add(`${trade.accountId}/${trade.date}`)
    }
  }
  const events = [
    ...book.openings.map((row) => ({
      date: row.date,
      key: `0/${row.id}`,
      opening: row,
      action: undefined as CorporateAction | undefined,
      trade: undefined as Trade | undefined,
      flow: undefined as Book['cashFlows'][number] | undefined,
    })),
    ...confirmed.map((row) => ({
      date: row.date,
      key: `1/${dateOrder.has(`${row.accountId}/${row.date}`) ? String(row.sequence).padStart(12, '0') : row.time || '00:00'}/${row.sequence}`,
      opening: undefined,
      action: undefined as CorporateAction | undefined,
      trade: row,
      flow: undefined,
    })),
    ...book.cashFlows.map((row) => ({
      date: row.date,
      key: `${row.side === 'in' ? '0' : '2'}/${row.sequence}`,
      opening: undefined,
      action: undefined as CorporateAction | undefined,
      trade: undefined,
      flow: row,
    })),
    ...(book.corporateActions || [])
      .filter((a) => a.status === 'confirmed')
      .flatMap((row) => [
        {
          date: row.date,
          key: `0.5/${row.id}`,
          action: row,
          settlement: false,
          opening: undefined,
          trade: undefined,
          flow: undefined,
        },
        ...(row.type === 'split'
          ? []
          : [
              {
                date: row.cashDate || row.date,
                key: `0.6/${row.id}`,
                action: row,
                settlement: true,
                opening: undefined,
                trade: undefined,
                flow: undefined,
              },
            ]),
      ]),
  ]
    .filter((event) => !throughDate || event.date <= throughDate)
    .sort((a, b) => a.date.localeCompare(b.date) || a.key.localeCompare(b.key))
  for (const event of events) {
    if (event.flow) {
      const f = event.flow
      const value = new D(result.cash[f.accountId])[f.side === 'in' ? 'plus' : 'minus'](f.amount)
      result.cash[f.accountId] = money(value)
      continue
    }
    const row = event.opening || event.action || event.trade!
    const key = positionKey(row.accountId, row.instrumentId)
    const position = result.positions[key] || {
      accountId: row.accountId,
      instrumentId: row.instrumentId,
      qty: '0',
      totalCost: '0.00',
      unitCost: '0',
      realizedPnl: '0.00',
    }
    result.positions[key] = position
    if (event.opening) {
      position.qty = event.opening.qty
      position.totalCost = money(event.opening.totalCost)
      position.unitCost = new D(position.totalCost).div(position.qty).toString()
      continue
    }
    if (event.action) {
      const action = event.action
      if ('settlement' in event && event.settlement) {
        const amount = new D(action.cashAmount)
        position.realizedPnl = new D(position.realizedPnl).plus(amount).toString()
        if (action.type === 'dividend')
          result.cash[action.accountId] = money(new D(result.cash[action.accountId]).plus(amount))
        else {
          position.qty = new D(position.qty).plus(action.addedQty).toString()
          position.totalCost = new D(position.totalCost).plus(amount).toString()
          position.unitCost = new D(position.totalCost).div(position.qty).toString()
        }
        continue
      }
      if (!new D(position.qty).eq(action.referenceQty))
        throw new Error('权益份额与生效日前持仓不一致，请先核对历史成交与导入基准')
      if (action.type === 'split') {
        position.qty = new D(position.qty).mul(action.ratio).toString()
        if (new D(position.qty).decimalPlaces() > 8)
          throw new Error('拆分后份额超过8位精度，请核对银行实际份额')
      } else {
        const amount = new D(action.cashAmount)
        const gross = new D(action.referenceQty).mul(action.cashPerShare).toDecimalPlaces(2)
        if (amount.gt(gross)) throw new Error('实际分红金额超过每份分红与权益份额的乘积')
        if (action.type === 'reinvest' && amount.lte(0)) throw new Error('红利再投确认金额须大于0')
      }
      position.unitCost = new D(position.totalCost).div(position.qty).toString()
      for (const plan of book.plans.filter(
        (p) =>
          p.accountId === action.accountId &&
          p.instrumentId === action.instrumentId &&
          p.createdAt.slice(0, 10) <= action.date,
      )) {
        const derived = result.plans[plan.id]
        if (derived.lastBuy) {
          const reference =
            action.type === 'split'
              ? new D(derived.lastBuy).div(action.ratio)
              : new D(derived.lastBuy).minus(action.cashPerShare)
          derived.lastBuy = reference.gt(0) ? reference.toString() : undefined
        }
      }
      continue
    }
    const trade = event.trade!,
      qty = new D(trade.qty),
      fee = new D(trade.fee)
    let gross = new D(trade.price).mul(qty).toDecimalPlaces(2)
    if (trade.inputBasis !== undefined && !['克', '元'].includes(trade.inputBasis))
      throw new Error('黄金录入依据无效')
    if (trade.inputAmount !== undefined) {
      const entered = decimalInput(trade.inputAmount, '银行实际成交金额', 2)
      if (
        book.instruments.find((i) => i.id === trade.instrumentId)!.type !== 'GOLD' ||
        entered.minus(gross).abs().gt('.01')
      )
        throw new Error('实际金额与克重、单价不一致，请核对银行确认值')
      gross = entered
    }
    if (trade.settlementAmount !== undefined) {
      const net = new D(trade.settlementAmount)
      gross = trade.side === 'buy' ? net.minus(fee) : net.plus(fee)
    }
    if (gross.lte(0)) throw new Error('成交金额小于有效记账精度')
    const plan = trade.planId ? result.plans[trade.planId] : undefined
    if (plan?.ended) throw new Error('本轮计划已结束，请新建下一轮再关联后续成交')
    if (trade.side === 'buy') {
      const net = gross.plus(fee)
      result.cash[trade.accountId] = money(new D(result.cash[trade.accountId]).minus(net))
      position.qty = new D(position.qty).plus(qty).toString()
      position.totalCost = new D(position.totalCost).plus(net).toString()
      position.unitCost = new D(position.totalCost).div(position.qty).toString()
      result.trades[trade.id] = { id: trade.id, gross: money(gross), net: money(net) }
      if (plan) {
        plan.used = money(new D(plan.used).plus(net))
        plan.lastBuy = isForeign(book.instruments.find((item) => item.id === trade.instrumentId)!)
          ? gross.div(qty).toString()
          : trade.price
      }
    } else {
      if (qty.gt(position.qty))
        throw new Error(
          `卖出数量超过成交当时持仓：${trade.date} ${book.instruments.find((i) => i.id === trade.instrumentId)!.name}，卖出 ${qty}，可用 ${position.qty}`,
        )
      const unitCostBefore = position.unitCost
      const cost = qty.eq(position.qty)
        ? new D(position.totalCost)
        : new D(position.totalCost).mul(qty).div(position.qty)
      const net = gross.minus(fee),
        pnl = net.minus(cost)
      if (net.lt(0)) throw new Error('卖出手续费超过成交金额')
      position.qty = new D(position.qty).minus(qty).toString()
      position.totalCost = new D(position.totalCost).minus(cost).toString()
      position.unitCost = new D(position.qty).isZero() ? '0' : unitCostBefore
      position.realizedPnl = new D(position.realizedPnl).plus(pnl).toString()
      result.cash[trade.accountId] = money(new D(result.cash[trade.accountId]).plus(net))
      result.trades[trade.id] = {
        id: trade.id,
        gross: money(gross),
        net: money(net),
        costBasis: cost.toString(),
        unitCostBefore,
        realizedPnl: pnl.toString(),
        returnPct: cost.isZero() ? '0' : pnl.div(cost).mul(100).toString(),
      }
      if (plan && new D(position.qty).isZero()) plan.ended = true
    }
  }
  result.availableCash = { ...result.cash }
  for (const plan of book.plans)
    result.plans[plan.id].eventBlocked = (book.corporateActions || []).some(
      (a) =>
        a.status === 'pending' &&
        a.accountId === plan.accountId &&
        a.instrumentId === plan.instrumentId &&
        (!throughDate || a.date <= throughDate),
    )
  // 历史视图只重放截至当日的成交；当前申请预留及活动轮次约束不能反套到过去。
  // 正常写入仍走下方完整校验，图表与公告发现不绕过当前账本的提交验证。
  if (throughDate) return result
  const reservedQty: Record<string, InstanceType<typeof D>> = {}
  for (const trade of book.trades.filter((t) => t.status === 'pending')) {
    const plan = trade.planId ? result.plans[trade.planId] : undefined
    if (plan?.ended) throw new Error('已结束计划仍有待确认申请，请先核对并处理')
    if (trade.side === 'buy') {
      const reserve = new D(trade.pendingAmount).plus(trade.fee)
      result.availableCash[trade.accountId] = money(
        new D(result.availableCash[trade.accountId]).minus(reserve),
      )
      if (plan) plan.reserved = money(new D(plan.reserved).plus(reserve))
    } else {
      const key = positionKey(trade.accountId, trade.instrumentId)
      reservedQty[key] = (reservedQty[key] || new D(0)).plus(trade.qty)
      if (reservedQty[key].gt(result.positions[key]?.qty || 0))
        throw new Error('待确认赎回与卖出合计超过可用份额')
    }
  }
  const activeKeys = new Set<string>()
  for (const plan of book.plans) {
    const derived = result.plans[plan.id]
    if (!derived.ended) {
      const key = positionKey(plan.accountId, plan.instrumentId)
      if (activeKeys.has(key)) throw new Error('同账户标的已有进行中计划，请先结束本轮')
      activeKeys.add(key)
    }
  }
  return result
}

/** 先克隆再变更，确认同日无时间记录的顺序后重放；幂等ID避免重复点击生成两笔。 */
export function recordTrade(
  book: Book,
  input: Trade,
  confirmOrder = false,
  confirmationId?: string,
): Book {
  const next: Book = JSON.parse(JSON.stringify(book))
  const existing = next.trades.find((t) => t.id === input.id)
  if (existing && !confirmationId) {
    if (JSON.stringify(existing) === JSON.stringify(input)) return book
    throw new Error('成交标识已存在，请勿重复提交')
  }
  if (confirmationId) {
    if (
      !existing ||
      existing.id !== confirmationId ||
      existing.status !== 'pending' ||
      input.status !== 'confirmed'
    )
      throw new Error('该申请已处理，请刷新记录')
    if (
      existing.accountId !== input.accountId ||
      existing.instrumentId !== input.instrumentId ||
      existing.side !== input.side ||
      existing.planId !== input.planId
    )
      throw new Error('确认申赎时不能更换账户、标的或计划')
    const applicationDate = existing.applicationDate || existing.date
    Object.assign(existing, input, { applicationDate })
  } else next.trades.push({ ...input })
  const group = next.trades.filter(
    (t) => t.accountId === input.accountId && t.date === input.date && t.status === 'confirmed',
  )
  if (group.length > 1 && group.some((t) => !t.time) && confirmOrder)
    group.forEach((t) => {
      t.orderConfirmed = true
    })
  for (const plan of next.plans.filter(
    (p) => p.accountId === input.accountId && p.instrumentId === input.instrumentId,
  )) {
    if (input.status === 'confirmed') {
      plan.observing = false
      delete plan.high
      delete plan.signal
      delete plan.signalDate
      delete plan.lastQuoteDate
      delete plan.lastFxDate
    } else if (plan.signal === 'buy') {
      // 申请仅预留资金或份额；撤回待买提醒，不丢弃既有持仓的止盈高点。
      delete plan.signal
      delete plan.signalDate
    }
  }
  const derived = projectBook(next)
  for (const plan of next.plans.filter(
    (p) => p.accountId === input.accountId && p.instrumentId === input.instrumentId,
  )) {
    appendPlanEvent(plan, {
      kind: 'trade',
      tradeId: input.id,
      reason:
        input.status === 'pending'
          ? '提交场外申请，预留资金或份额；尚未形成成交'
          : `记录实际${input.side === 'buy' ? '买入' : '卖出'}，重放账本并重置行情跟踪${derived.plans[plan.id].ended ? '；本轮已结束' : ''}`,
      previous: planSnapshot(book.plans.find((p) => p.id === plan.id)!),
    })
  }
  return next
}

/** 更正保留稳定ID、原顺序与原值记录；完整重放后才返回，失败不修改原账本。 */
export function correctTrade(book: Book, input: Trade, confirmOrder = false): Book {
  const old = book.trades.find((trade) => trade.id === input.id)
  if (!old || old.status !== 'confirmed' || input.status !== 'confirmed')
    throw new Error('只能更正已确认成交，待确认申请请先确认或撤销')
  const replacement: Trade = {
    ...input,
    sequence: old.sequence,
    orderConfirmed: old.orderConfirmed || input.orderConfirmed,
    applicationDate: old.applicationDate,
  }
  const fields = [
    'accountId',
    'instrumentId',
    'planId',
    'side',
    'date',
    'time',
    'qty',
    'price',
    'fee',
    'settlementAmount',
    'inputAmount',
    'inputBasis',
  ] as const
  if (fields.every((field) => old[field] === replacement[field])) return book
  const { corrections, ...previous } = old
  replacement.corrections = [
    ...(corrections || []),
    {
      recordedAt: new Date().toISOString(),
      previous: { ...previous },
    },
  ]
  const base: Book = { ...book, trades: book.trades.filter((trade) => trade.id !== old.id) }
  const next = recordTrade(base, replacement, confirmOrder)
  for (const plan of next.plans.filter(
    (p) =>
      (p.accountId === old.accountId && p.instrumentId === old.instrumentId) ||
      (p.accountId === replacement.accountId && p.instrumentId === replacement.instrumentId),
  )) {
    const prior = planSnapshot(book.plans.find((p) => p.id === plan.id)!)
    const event = plan.history?.[plan.history.length - 1]
    const reason = '更正历史成交并重放后续现金、持仓、成本与卖出盈亏；原值保留在成交更正记录'
    if (
      event?.kind === 'trade' &&
      event.tradeId === old.id &&
      plan.accountId === replacement.accountId &&
      plan.instrumentId === replacement.instrumentId
    ) {
      event.reason = reason
      event.previous = prior
    } else {
      plan.observing = false
      delete plan.high
      delete plan.signal
      delete plan.signalDate
      delete plan.lastQuoteDate
      delete plan.lastFxDate
      appendPlanEvent(plan, { kind: 'trade', tradeId: old.id, previous: prior, reason })
    }
  }
  projectBook(next)
  return next
}

/** 删除手工流水后完整重放，依赖它的卖出或权益非法时拒绝；原账本始终不变。 */
export function deleteTrade(book: Book, id: string): Book {
  const old = book.trades.find((trade) => trade.id === id)
  if (!old) throw new Error('交易记录不存在，请刷新后重试')
  const next: Book = JSON.parse(JSON.stringify(book))
  next.trades = next.trades.filter((trade) => trade.id !== id)
  for (const plan of next.plans.filter(
    (p) => p.accountId === old.accountId && p.instrumentId === old.instrumentId,
  )) {
    const previous = planSnapshot(plan)
    // 未确认申请只释放预留，不能抹掉已经实际采集到的止盈观察高点。
    if (old.status === 'confirmed') {
      plan.observing = false
      delete plan.high
      delete plan.signal
      delete plan.signalDate
      delete plan.lastQuoteDate
      delete plan.lastFxDate
    }
    appendPlanEvent(plan, {
      kind: 'trade',
      tradeId: old.id,
      previous,
      reason:
        old.status === 'confirmed'
          ? '删除手动成交并重放现金、持仓、成本与后续盈亏；观察状态从下一次行情重新采集'
          : '删除未成交的手动申请记录并释放预留，保留已采集的观察高点',
    })
  }
  projectBook(next)
  return next
}

/** 核对待确认事件后再改数量/现金；事件和策略暂停历史在同一账本提交，重复提交幂等。 */
export function recordCorporateAction(book: Book, input: CorporateAction): Book {
  const next: Book = JSON.parse(JSON.stringify(book))
  const actions = next.corporateActions || []
  const old = actions.find((a) => a.id === input.id)
  if (old) {
    if (JSON.stringify(old) === JSON.stringify(input)) return book
    if (old.status === 'confirmed') throw new Error('权益事件已确认，不能重复覆盖')
    if (
      old.accountId !== input.accountId ||
      old.instrumentId !== input.instrumentId ||
      old.date !== input.date
    )
      throw new Error('核对权益事件不能改变账户、标的或日期')
    actions[actions.indexOf(old)] = { ...input }
  } else actions.push({ ...input })
  next.corporateActions = actions
  projectBook(next)
  for (const plan of next.plans.filter(
    (p) => p.accountId === input.accountId && p.instrumentId === input.instrumentId,
  )) {
    const previous = planSnapshot(plan)
    plan.paused = true
    plan.observing = false
    delete plan.high
    delete plan.signal
    delete plan.signalDate
    delete plan.lastQuoteDate
    delete plan.lastFxDate
    appendPlanEvent(plan, {
      kind: 'corporate-action',
      previous,
      reason:
        input.status === 'pending'
          ? '登记待核对权益事件，停止相关策略提醒'
          : '确认权益事件并重放数量、现金与参考买点；计划保持暂停，核对后手动恢复',
    })
  }
  return next
}

/** 海外确认单必须给出实际人民币净额；境内不接受覆盖原成交算法的结算值。 */
function validateSettlement(trade: Trade | Omit<Trade, 'corrections'>, item: Instrument): void {
  if (isForeign(item)) {
    const net = decimalInput(trade.settlementAmount!, '实际人民币结算金额', 2)
    if (trade.side === 'buy' && net.lte(trade.fee)) throw new Error('人民币支出须大于手续费')
    if (trade.inputAmount !== undefined || trade.inputBasis !== undefined)
      throw new Error('股票不使用黄金换算字段')
  } else if (trade.settlementAmount !== undefined) throw new Error('境内成交不使用外币结算金额')
}
