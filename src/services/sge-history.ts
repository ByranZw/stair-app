import type { History, HistoryPoint, Instrument } from '../domain/market'

export const SGE_HISTORY_SOURCE = '上金所 Au99.99 · 市场参考收盘价'
export const SGE_MINUTE_SOURCE = '上金所 Au99.99 · 市场参考延时分时'

/** 只为招行黄金详情提供市场参考，禁止把另一产品请求误映射为招行报价。 */
function assertGold(instrument: Instrument): void {
  if (instrument.id !== 'GOLD:CMB-GOLD' || instrument.type !== 'GOLD')
    throw new Error('黄金市场参考仅用于招行黄金账户详情')
}

/** 外部价格只接受有限正数，不把缺值、零和预填空串变成有效行情。 */
function positive(value: unknown): string {
  if (
    (typeof value !== 'number' && typeof value !== 'string') ||
    !/^\d+(?:\.\d+)?$/.test(String(value)) ||
    !Number.isFinite(Number(value)) ||
    Number(value) <= 0
  )
    throw new Error('上金所返回了无效价格')
  return String(value)
}

/** 官网K线顺序为日期、开盘、收盘、最低、最高；返回独立市场参考，不生成银行Quote。 */
export function parseSgeDaily(raw: unknown, instrument: Instrument): History {
  assertGold(instrument)
  const rows = (raw as { time?: unknown })?.time
  if (!Array.isArray(rows) || !rows.length) throw new Error('上金所暂无可用历史行情')
  const points: HistoryPoint[] = rows.map((row: unknown) => {
    if (!Array.isArray(row) || row.length < 3 || !/^\d{4}-\d{2}-\d{2}$/.test(row[0]))
      throw new Error('上金所历史行情格式发生变化')
    const [date, open, value, low, high] = row
    const point: HistoryPoint = { date, value: positive(value) }
    // 旧记录偶有高低价与收盘价冲突，保留收盘日线而不伪造可用K线。
    try {
      const fields = { open: positive(open), low: positive(low), high: positive(high) }
      if (
        Number(fields.low) <= Math.min(Number(fields.open), Number(point.value)) &&
        Number(fields.high) >= Math.max(Number(fields.open), Number(point.value))
      )
        Object.assign(point, fields)
    } catch {
      // 非法OHLC只降级为收盘点；非法收盘已在上方拒绝。
    }
    return point
  })
  points.sort((a, b) => a.date.localeCompare(b.date))
  if (new Set(points.map((p) => p.date)).size !== points.length)
    throw new Error('上金所历史行情出现重复日期')
  return {
    instrumentId: instrument.id,
    points,
    source: SGE_HISTORY_SOURCE,
    resolution: 'day',
    fetchedAt: new Date().toISOString(),
  }
}

/** 上海时间不依赖设备时区；分时轴从20:00开始，凌晨及日盘属于下一日历日。 */
function shanghaiDate(stamp: number): string {
  return new Date(stamp + 8 * 3600000).toISOString().slice(0, 10)
}

/** 截断now之后的供应方预填数据；夜盘日期使用实际接收日历而非可能属于次日的交易日标签。 */
export function parseSgeMinute(
  raw: unknown,
  instrument: Instrument,
  receivedAt = new Date(),
): History {
  assertGold(instrument)
  const data = raw as {
    heyue?: string
    times?: unknown
    data?: unknown
    now?: string
    delaystr?: string
  }
  if (
    data?.heyue !== 'Au99.99' ||
    !Array.isArray(data.times) ||
    !Array.isArray(data.data) ||
    data.times.length !== data.data.length
  )
    throw new Error('上金所分时行情格式发生变化')
  const nowIndex = data.times.indexOf(data.now)
  if (nowIndex < 0 || !/^\d{2}:\d{2}$/.test(data.now || ''))
    throw new Error('上金所分时缺少有效截止时间')
  const fetchedAt = receivedAt.toISOString()
  const received = receivedAt.getTime()
  if (!Number.isFinite(received)) throw new Error('分时接收时间无效')
  const today = shanghaiDate(received)
  const label = data.delaystr?.match(/^(\d{4})年(\d{2})月(\d{2})日 (\d{2}:\d{2}):\d{2}$/)
  if (!label) throw new Error('上金所分时缺少有效行情日期')
  const publishedIndex = data.times.indexOf(label[4])
  if (publishedIndex < 0) throw new Error('上金所分时缺少有效发布时间')
  // 来源的now和发布时间非原子更新，取较早刻度，不能把尚未发布的预填值画出来。
  const cutoffIndex = Math.min(nowIndex, publishedIndex)
  const cutoffTime = String(data.times[cutoffIndex])
  const tradingDate = `${label[1]}-${label[2]}-${label[3]}`
  const tradingStamp = Date.parse(`${tradingDate}T12:00:00+08:00`)
  const weekday = new Date(tradingStamp + 8 * 3600000).getUTCDay()
  if (!Number.isFinite(tradingStamp) || weekday === 0 || weekday === 6)
    throw new Error('上金所分时交易日无效')
  // 官网周一交易日的夜盘从上周五开始；按来源交易日定位，不能按接收日平移旧行情。
  const startDay = shanghaiDate(tradingStamp - (weekday === 1 ? 3 : 1) * 86400000)
  const nextDay = shanghaiDate(Date.parse(`${startDay}T12:00:00+08:00`) + 86400000)
  const currentDay = cutoffTime >= '20:00' ? startDay : cutoffTime < '03:00' ? nextDay : tradingDate
  const cutoff = Date.parse(`${currentDay}T${cutoffTime}:00+08:00`)
  if (currentDay !== today || cutoff > received + 60000)
    throw new Error('上金所分时交易日与当前时段不符')
  const points: HistoryPoint[] = []
  for (let i = 0; i <= cutoffIndex; i++) {
    const time = data.times[i]
    if (typeof time !== 'string' || !/^\d{2}:\d{2}$/.test(time))
      throw new Error('上金所分时刻度无效')
    const date = `${time >= '20:00' ? startDay : time < '03:00' ? nextDay : tradingDate} ${time}`
    const value = data.data[i]
    if (value === '' || value === null || value === '-') continue
    points.push({ date, value: positive(value) })
  }
  if (!points.length) throw new Error('上金所暂无可用分时行情')
  return {
    instrumentId: instrument.id,
    points,
    source: `${SGE_MINUTE_SOURCE} · 交易日 ${tradingDate}`,
    resolution: 'minute',
    fetchedAt,
  }
}
