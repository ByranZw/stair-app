import { validInstrument } from '../domain/currency'
import { reactive } from 'vue'
import type { History, Instrument, Quote } from '../domain/market'
import { fetchMarket, fetchMinute, fetchGoldHistory } from '../services/market'
import { mergeHistory } from '../domain/chart'
import { SGE_HISTORY_SOURCE } from '../services/sge-history'
const WATCH_KEY = 'stair.watchlist.v1',
  CACHE_KEY = 'stair.market.v1'

/** 银行报价独立于上金所图表；旧版参考槽只在加载时迁移。 */
interface MarketCache {
  quote: Quote
  history: History
  minute?: History
}

/** 参考缓存须带来源身份和有效价格，避免旧的银行采样混入上金所曲线。 */
function validGoldHistory(value: History | undefined, id: string, minute = false): boolean {
  return (
    !!value &&
    id === 'GOLD:CMB-GOLD' &&
    value?.instrumentId === id &&
    typeof value.source === 'string' &&
    value.source.startsWith('上金所 Au99.99') &&
    value.resolution === (minute ? 'minute' : 'day') &&
    typeof value.fetchedAt === 'string' &&
    Array.isArray(value.points) &&
    value.points.every(
      (point) =>
        point &&
        typeof point.date === 'string' &&
        (minute ? /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/ : /^\d{4}-\d{2}-\d{2}$/).test(point.date) &&
        typeof point.value === 'string' &&
        /^\d+(?:\.\d+)?$/.test(point.value),
    )
  )
}

/** 本轮存储仅用于自选和公开行情，后续交易账本另用事务数据库。 */
function readStorage(key: string): unknown {
  try {
    return uni.getStorageSync(key) || undefined
  } catch {
    return undefined
  }
}
/** 损坏或未来版本的本地结构不阻止空页面启动。 */
function loadWatchlist(): Instrument[] {
  const saved = readStorage(WATCH_KEY)
  if (!Array.isArray(saved)) return []
  return saved.filter((item): item is Instrument => validInstrument(item))
}
/** 缓存仅接受与标的匹配且带日期来源的数据；失败不能生成新价格。 */
function loadCache(): Record<string, MarketCache> {
  const saved = readStorage(CACHE_KEY)
  if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {}
  return Object.fromEntries(
    Object.entries(saved)
      .map(([id, original]) => {
        if (id !== 'GOLD:CMB-GOLD' || !original || typeof original !== 'object')
          return [id, original]
        const entry = original as MarketCache & {
          referenceHistory?: History
          referenceMinute?: History
        }
        const history = validGoldHistory(entry.history, id)
          ? entry.history
          : validGoldHistory(entry.referenceHistory, id)
            ? entry.referenceHistory!
            : {
                instrumentId: id,
                points: [],
                source: SGE_HISTORY_SOURCE,
                fetchedAt: new Date().toISOString(),
                resolution: 'day' as const,
              }
        const minute = validGoldHistory(entry.minute, id, true)
          ? entry.minute
          : validGoldHistory(entry.referenceMinute, id, true)
            ? entry.referenceMinute
            : undefined
        return [id, { quote: entry.quote, history, minute }]
      })
      .filter(
        ([id, entry]) =>
          entry &&
          typeof entry === 'object' &&
          entry.quote?.instrumentId === id &&
          entry.history?.instrumentId === id &&
          /^\d+(?:\.\d+)?$/.test(entry.quote.value) &&
          typeof entry.quote.date === 'string' &&
          typeof entry.quote.source === 'string' &&
          typeof entry.quote.fetchedAt === 'string' &&
          Array.isArray(entry.history.points) &&
          entry.history.points.every(
            (point: { date: unknown; value: unknown } | null) =>
              !!point &&
              typeof point === 'object' &&
              typeof point.date === 'string' &&
              typeof point.value === 'string' &&
              /^\d+(?:\.\d+)?$/.test(point.value),
          ) &&
          (entry.minute === undefined ||
            (entry.minute?.instrumentId === id &&
              Array.isArray(entry.minute.points) &&
              entry.minute.points.every(
                (point: { date?: string; value?: string }) =>
                  point &&
                  typeof point.date === 'string' &&
                  /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(point.date) &&
                  typeof point.value === 'string' &&
                  /^\d+(?:\.\d+)?$/.test(point.value),
              ))),
      ),
  )
}
export const watchState = reactive({
  items: loadWatchlist(),
  cache: loadCache(),
  errors: {} as Record<string, string>,
  loading: {} as Record<string, boolean>,
})
const inflight = new Map<string, Promise<void>>()
const goldHistoryFailures = new Map<string, number>()
let owned: Instrument[] = []
/** 持仓与计划独立于自选存在，行情刷新取二者并集。 */
export function setOwnedInstruments(items: Instrument[]): void {
  owned = items
}

/** 先持久化关注关系再刷新，重复加入不改变顺序或创建持仓。 */
export function addInstrument(instrument: Instrument): void {
  if (watchState.items.some((item) => item.id === instrument.id)) return
  const next = [...watchState.items, instrument]
  uni.setStorageSync(WATCH_KEY, next)
  watchState.items = next
  void refreshInstrument(instrument)
}
/** 删除只影响关注列表，不触及未来持仓、计划与成交。 */
export function removeInstrument(id: string): void {
  const next = watchState.items.filter((item) => item.id !== id)
  uni.setStorageSync(WATCH_KEY, next)
  watchState.items = next
}
/** 股价与汇率各自不能倒退；保留完整的旧组合，避免刷新与历史回补交错时估值回退。 */
function quoteRegresses(previous: Quote, next: Quote): boolean {
  return (
    next.date < previous.date ||
    !!(previous.fxDate && (!next.fxDate || next.fxDate < previous.fxDate))
  )
}

/** 同标的请求合并，旧时间响应不覆盖新报价；失败保留缓存并单独呈现。 */
export function refreshInstrument(instrument: Instrument): Promise<void> {
  const existing = inflight.get(instrument.id)
  if (existing) return existing
  watchState.loading[instrument.id] = true
  const oldPoints = watchState.cache[instrument.id]?.history.points || []
  const start = oldPoints[Math.max(0, oldPoints.length - 10)]?.date || ''
  const task = fetchMarket(instrument, start)
    .then((result) => {
      const previous = watchState.cache[instrument.id]
      if (previous && quoteRegresses(previous.quote, result.quote))
        throw new Error('来源返回较旧报价或汇率，已保留原缓存')
      const merged = {
        ...previous,
        ...result,
        history:
          instrument.type === 'GOLD'
            ? (previous?.history ?? result.history)
            : mergeHistory(previous?.history, result.history),
        minute: previous?.minute,
      }
      uni.setStorageSync(CACHE_KEY, { ...watchState.cache, [instrument.id]: merged })
      watchState.cache[instrument.id] = merged
      delete watchState.errors[instrument.id]
    })
    .catch((error) => {
      watchState.errors[instrument.id] = error instanceof Error ? error.message : '行情获取失败'
    })
    .finally(() => {
      watchState.loading[instrument.id] = false
      inflight.delete(instrument.id)
    })
  inflight.set(instrument.id, task)
  return task
}

/** 独立请求市场曲线；分钟缓存复用60秒，失败冷却5分钟，避免免费源限流后持续请求。 */
export function refreshGoldHistory(instrument: Instrument, minute = false): Promise<void> {
  const key = instrument.id + (minute ? '/minute' : '/history')
  const existing = inflight.get(key)
  if (existing) return existing
  const now = Date.now()
  const failedAt = goldHistoryFailures.get(key)
  if (failedAt !== undefined && now - failedAt < 5 * 60000) return Promise.resolve()
  const cached = watchState.cache[instrument.id]?.minute
  const age = cached ? now - Date.parse(cached.fetchedAt) : Infinity
  if (minute && validGoldHistory(cached, instrument.id, true) && age >= 0 && age < 60000)
    return Promise.resolve()
  watchState.loading[key] = true
  const task = fetchGoldHistory(instrument, minute)
    .then((history) => {
      const previous = watchState.cache[instrument.id]
      if (!previous) throw new Error('请先取得该标的银行报价，再刷新黄金走势')
      const next = {
        ...previous,
        [minute ? 'minute' : 'history']: history,
      }
      uni.setStorageSync(CACHE_KEY, { ...watchState.cache, [instrument.id]: next })
      watchState.cache[instrument.id] = next
      goldHistoryFailures.delete(key)
      delete watchState.errors[key]
    })
    .catch((error) => {
      goldHistoryFailures.set(key, Date.now())
      watchState.errors[key] = error instanceof Error ? error.message : '市场参考走势获取失败'
    })
    .finally(() => {
      watchState.loading[key] = false
      inflight.delete(key)
    })
  inflight.set(key, task)
  return task
}

/** 切换分时时单独请求；失败保留带所属日期的旧分钟缓存，不改策略报价。 */
export async function refreshMinute(instrument: Instrument): Promise<void> {
  if (instrument.type === 'GOLD') return refreshGoldHistory(instrument, true)
  const key = instrument.id + '/minute'
  if (inflight.has(key)) return inflight.get(key)
  watchState.loading[key] = true
  const task = fetchMinute(instrument)
    .then((minute) => {
      const previous = watchState.cache[instrument.id]
      if (!previous) throw new Error('请先取得该标的行情')
      const next = { ...previous, minute }
      uni.setStorageSync(CACHE_KEY, { ...watchState.cache, [instrument.id]: next })
      watchState.cache[instrument.id] = next
      delete watchState.errors[key]
    })
    .catch((error) => {
      watchState.errors[key] = error instanceof Error ? error.message : '分时获取失败'
    })
    .finally(() => {
      watchState.loading[key] = false
      inflight.delete(key)
    })
  inflight.set(key, task)
  return task
}

/** 用户扩大区间才回补较早历史；保留原覆盖与新报价，不能用旧快照覆盖同时刷新的结果。 */
export async function loadMoreHistory(instrument: Instrument): Promise<void> {
  if (instrument.type === 'GOLD') return refreshGoldHistory(instrument)
  const key = instrument.id + '/history'
  if (inflight.has(key)) return inflight.get(key)
  watchState.loading[key] = true
  const task = fetchMarket(instrument, '', 640)
    .then((result) => {
      const previous = watchState.cache[instrument.id]
      const next = {
        ...previous,
        quote:
          previous && quoteRegresses(previous.quote, result.quote) ? previous.quote : result.quote,
        history:
          previous && quoteRegresses(previous.quote, result.quote)
            ? mergeHistory(result.history, previous.history)
            : mergeHistory(previous?.history, result.history),
      }
      uni.setStorageSync(CACHE_KEY, { ...watchState.cache, [instrument.id]: next })
      watchState.cache[instrument.id] = next
      delete watchState.errors[key]
    })
    .catch((error) => {
      watchState.errors[key] = error instanceof Error ? error.message : '历史加载失败'
    })
    .finally(() => {
      watchState.loading[key] = false
      inflight.delete(key)
    })
  inflight.set(key, task)
  return task
}
/** 只由启动、前台返回和手动操作调用，不建立后台轮询。 */
export async function refreshAll(): Promise<void> {
  const items = new Map([...watchState.items, ...owned].map((item) => [item.id, item]))
  const list = [...items.values()]
  // 免费来源按最多4个标的分批读取，失败由各标的保留缓存，不阻塞后续批次。
  for (let start = 0; start < list.length; start += 4)
    await Promise.all(list.slice(start, start + 4).map(refreshInstrument))
}
