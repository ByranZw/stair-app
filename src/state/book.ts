import { maintainOpening, maintainCashFlow } from '../domain/maintenance'
import { computed, reactive, ref, watch } from 'vue'
import type {
  Account,
  Book,
  CashFlow,
  CorporateAction,
  OpeningPosition,
  Plan,
  Trade,
} from '../domain/book'
import { emptyBook, positionKey } from '../domain/book'
import {
  projectBook,
  recordTrade,
  correctTrade,
  deleteTrade,
  correctAccount,
  recordCorporateAction,
} from '../domain/ledger'
import { evaluatePlan, isStrategyQuoteFresh } from '../domain/strategy'
import { discoverActions } from '../domain/discover-actions'
import { appendPlanEvent, planSnapshot, recordQuoteHistory } from '../domain/plan-history'
import { createBackup, readBackup, prepareRestoredBook } from '../domain/backup'
import type { Instrument } from '../domain/market'
import type { BookStorage, Recovery } from '../storage/book-storage'
import { openIndexedBook } from '../storage/indexed-book'
import { openSqliteBook } from '../storage/sqlite-book'
import { setOwnedInstruments, watchState } from './watchlist'

export const bookState = reactive({
  data: emptyBook(),
  ready: false,
  busy: false,
  error: '',
  lastSaveError: '',
})
export const selectedAccountId = ref('')
export const projection = computed(() => projectBook(bookState.data))
let storage: BookStorage | undefined, initialization: Promise<void> | undefined
let writes: Promise<unknown> = Promise.resolve()

/** 标识生成不包含账户名称；最终唯一性仍由账本校验和主键约束保证。 */
export function newId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}
/** Vue代理只存十进制文本与普通对象，事务前克隆避免修改失败泄漏到页面。 */
function cloneBook(): Book {
  return JSON.parse(JSON.stringify(bookState.data))
}
/** 已持有或有计划的标的也刷新，移除自选不影响账户估值。 */
function syncOwned(): void {
  const owned = new Set([
    ...Object.values(projection.value.positions)
      .filter((p) => Number(p.qty) > 0)
      .map((p) => p.instrumentId),
    ...bookState.data.plans
      .filter((p) => !projection.value.plans[p.id].ended)
      .map((p) => p.instrumentId),
  ])
  setOwnedInstruments(bookState.data.instruments.filter((item) => owned.has(item.id)))
}
/** 浏览器与App选择各自事务数据库；读取失败保持只读错误，绝不创建空账本覆盖。 */
export function initializeBook(): Promise<void> {
  if (initialization) return initialization
  initialization = (async () => {
    try {
      let connection: BookStorage | undefined
      // #ifdef H5
      connection = await openIndexedBook()
      // #endif
      // #ifdef APP-PLUS
      connection = await openSqliteBook()
      // #endif
      if (!connection) throw new Error('当前运行环境尚未支持本地账本')
      storage = connection
      const data = await connection.load()
      projectBook(data)
      bookState.data = data
      bookState.ready = true
      syncOwned()
    } catch (error) {
      bookState.error = error instanceof Error ? error.message : '账本无法读取，请保留本地数据'
      throw error
    }
  })()
  return initialization
}
/** 所有操作串行执行；删除和恢复核对确认时版本，持久层成功后才发布状态。 */
export function updateBook(
  change: (draft: Book) => Book | void,
  options?: { expectedRevision: number; saveRecovery: boolean },
): Promise<void> {
  const next = writes.then(async () => {
    await initializeBook()
    bookState.busy = true
    try {
      if (options && bookState.data.revision !== options.expectedRevision)
        throw new Error('账本已有更新，请重新核对后再操作')
      const recovery: Recovery | undefined = options?.saveRecovery
        ? { createdAt: new Date().toISOString(), book: cloneBook() }
        : undefined
      const draft = cloneBook(),
        changed = change(draft) || draft
      if (JSON.stringify(changed) === JSON.stringify(bookState.data)) return
      const expected = bookState.data.revision
      changed.revision = expected + 1
      const derived = projectBook(changed)
      // 表单与重放校验失败由调用界面呈现，只有真正的持久化故障留在账本级。
      try {
        await storage!.save(changed, derived, expected, recovery)
      } catch (error) {
        bookState.lastSaveError = error instanceof Error ? error.message : '账本保存失败'
        throw error
      }
      bookState.data = changed
      bookState.lastSaveError = ''
      syncOwned()
    } finally {
      bookState.busy = false
    }
  })
  writes = next.catch(() => undefined)
  return next
}
/** 新账户只记录明确的现金基准，不替用户构造历史资金流。 */
export async function createAccount(
  name: string,
  openingCash: string,
  date: string,
): Promise<string> {
  const id = newId('account')
  await updateBook((book) => {
    const account: Account = { id, name: name.trim(), openingCash, date }
    if (book.accounts.some((a) => a.name === account.name)) throw new Error('账户名称已存在')
    book.accounts.push(account)
  })
  selectedAccountId.value = id
  return id
}
/** 账户更正核对编辑基准及事务版本，账本与操作前副本同事务保存。 */
export async function saveAccountCorrection(
  accountId: string,
  input: Pick<Account, 'name' | 'openingCash' | 'date'>,
  expectedRevision: number,
  baseline?: Pick<Account, 'name' | 'openingCash' | 'date'>,
): Promise<void> {
  await updateBook((book) => correctAccount(book, accountId, input, baseline), {
    expectedRevision,
    saveRecovery: true,
  })
}
/** 将选择过的品种身份固化到账本，今后移除自选也能恢复历史名称。 */
export function retainInstrument(book: Book, instrument: Instrument): void {
  if (!book.instruments.some((i) => i.id === instrument.id))
    book.instruments.push({ ...instrument })
}
/** 导入数量与总成本不扣减现金，也不生成虚假的历史买点。 */
export async function importPosition(
  input: Omit<OpeningPosition, 'id'>,
  instrument: Instrument,
): Promise<void> {
  await updateBook((book) => {
    retainInstrument(book, instrument)
    book.openings.push({ ...input, id: newId('opening') })
  })
}
/** 资金流水与交易分开，日期内转入先于成交，转出按日末处理。 */
export async function recordCashFlow(input: Omit<CashFlow, 'id' | 'sequence'>): Promise<void> {
  await updateBook((book) => {
    book.cashFlows.push({ ...input, id: newId('cash'), sequence: Date.now() })
  })
}
/** 原子记录或确认申赎；调用方稳定的交易ID同时用于重复提交保护。 */
export async function saveTrade(
  input: Trade,
  instrument: Instrument,
  confirmOrder: boolean,
  confirmationId?: string,
): Promise<void> {
  await updateBook((book) => {
    retainInstrument(book, instrument)
    return recordTrade(book, input, confirmOrder, confirmationId)
  })
}
/** 权益核对和实际变更走同一账本事务，失败保留原数据。 */
export async function saveCorporateAction(input: CorporateAction): Promise<void> {
  await updateBook((book) => recordCorporateAction(book, input))
}
/** 更正与后续重算在原有事务内一起提交，归属改变也保留旧计划的操作历史。 */
export async function correctSavedTrade(
  input: Trade,
  instrument: Instrument,
  confirmOrder: boolean,
): Promise<void> {
  await updateBook((book) => {
    retainInstrument(book, instrument)
    return correctTrade(book, input, confirmOrder)
  })
}

/** 删除确认绑定所见版本；重放、操作前副本与新账本一次原子保存，失败不发布状态。 */
export async function deleteSavedTrade(id: string, expectedRevision: number): Promise<void> {
  await updateBook((book) => deleteTrade(book, id), { expectedRevision, saveRecovery: true })
}

/** 撤销未确认申请只释放预留，保留申请记录，不删除已确认交易。 */
export async function cancelPending(id: string): Promise<void> {
  await updateBook((book) => {
    const row = book.trades.find((t) => t.id === id)
    if (!row || row.status !== 'pending') throw new Error('申请已处理，请刷新')
    row.status = 'cancelled'
    if (row.planId) {
      const plan = book.plans.find((p) => p.id === row.planId)!
      appendPlanEvent(plan, {
        kind: 'trade',
        tradeId: row.id,
        reason: '撤销场外申请，释放预留；未形成成交',
      })
    }
  })
}
/** 计划参数保存版本快照，修改后重新开始有效行情跟踪，不沿用旧成本高点。 */
export async function savePlan(
  input: Omit<Plan, 'version' | 'createdAt' | 'paused' | 'observing'>,
  instrument: Instrument,
): Promise<void> {
  await updateBook((book) => {
    retainInstrument(book, instrument)
    const old = book.plans.find((p) => p.id === input.id)
    if (old && projectBook(book).plans[old.id].ended) throw new Error('本轮已结束，请新建下一轮')
    const plan: Plan = {
      ...input,
      version: old ? old.version + 1 : 1,
      createdAt: old?.createdAt || new Date().toISOString(),
      paused: old?.paused || false,
      observing: false,
      history: old?.history,
    }
    appendPlanEvent(plan, {
      kind: old ? 'parameters' : 'created',
      reason: old
        ? '调整本轮参数，保留旧版本并重新开始行情跟踪'
        : '创建本轮投资计划，保存独立参数快照',
      previous: old ? planSnapshot(old) : undefined,
    })
    if (old) {
      if (old.accountId !== input.accountId || old.instrumentId !== input.instrumentId)
        throw new Error('调整计划不能改变账户或标的')
      book.plans[book.plans.indexOf(old)] = plan
    } else book.plans.push(plan)
  })
}
/** 分红拆分或用户暂停时停止提醒；恢复不臆造暂停期间的行情高点。 */
export async function pausePlan(id: string, paused: boolean): Promise<void> {
  await updateBook((book) => {
    const plan = book.plans.find((p) => p.id === id)
    if (!plan) throw new Error('计划不存在')
    if (plan.paused === paused) return
    const previous = planSnapshot(plan)
    plan.paused = paused
    plan.observing = false
    delete plan.high
    delete plan.signal
    delete plan.lastQuoteDate
    delete plan.signalDate
    appendPlanEvent(plan, {
      kind: paused ? 'paused' : 'resumed',
      previous,
      reason: paused ? '用户暂停计划并清除待执行提醒' : '用户恢复计划，等待新行情重新跟踪',
    })
  })
}
/** 先发现待核对权益，再用新鲜行情判断；来源失败和非交易黄金不能触发策略。 */
async function processQuotes(): Promise<void> {
  if (!bookState.ready) return
  await updateBook((book) => {
    for (const [id, entry] of Object.entries(watchState.cache)) {
      if (!watchState.errors[id] && entry.quote.actions)
        book = discoverActions(book, id, entry.quote.actions)
    }
    const derived = projectBook(book)
    book.plans = book.plans.map((plan) => {
      const quote = watchState.cache[plan.instrumentId]?.quote
      if (!quote || watchState.errors[plan.instrumentId]) return plan
      if (
        quote.corporateAction &&
        !(book.corporateActions || []).some(
          (a) =>
            a.status === 'confirmed' &&
            a.accountId === plan.accountId &&
            a.instrumentId === plan.instrumentId &&
            a.date === quote.date.slice(0, 10),
        )
      ) {
        if (plan.paused && plan.history?.[plan.history.length - 1]?.kind === 'corporate-action')
          return plan
        const next = { ...plan, paused: true, observing: false }
        delete next.high
        delete next.signal
        delete next.signalDate
        appendPlanEvent(next, {
          kind: 'corporate-action',
          previous: planSnapshot(plan),
          reason: '来源标记分红或拆分，暂停提醒，等待核对事件与参考价格',
        })
        return next
      }
      const next = evaluatePlan(
        plan,
        derived.plans[plan.id],
        derived.positions[positionKey(plan.accountId, plan.instrumentId)],
        book.trades,
        quote,
        isStrategyQuoteFresh(quote),
      )
      return recordQuoteHistory(
        plan,
        next,
        quote,
        derived.plans[plan.id],
        derived.positions[positionKey(plan.accountId, plan.instrumentId)],
      )
    })
    return book
  })
}
watch(
  () =>
    Object.values(watchState.cache)
      .map((row) => `${row.quote.instrumentId}/${row.quote.fetchedAt}`)
      .join('|'),
  () => {
    void processQuotes().catch(() => undefined)
  },
)

/** 导出等待已排队写入完成，拿到的始终是同一份已提交账本快照。 */
export async function exportBook(): Promise<string> {
  await initializeBook()
  await writes
  return createBackup(cloneBook())
}
/** 确认时再次校验原文件与本机版本；恢复前副本和新账本同事务落地。 */
export async function restoreBook(text: string, expectedRevision: number): Promise<void> {
  const backup = readBackup(text)
  await updateBook(() => prepareRestoredBook(backup.book), { expectedRevision, saveRecovery: true })
  selectedAccountId.value = ''
}
/** 取回最近一次恢复前的账本，仍走相同预检与显式恢复路径，不静默覆盖。 */
export async function readRecoveryBackup(): Promise<
  { createdAt: string; text: string } | undefined
> {
  await initializeBook()
  await writes
  const recovery = await storage!.loadRecovery()
  return recovery
    ? { createdAt: recovery.createdAt, text: createBackup(recovery.book, recovery.createdAt) }
    : undefined
}

/** 初始持仓修改及重算同事务保存，并保留操作前的恢复副本。 */
export async function saveOpeningCorrection(
  id: string,
  input: Omit<OpeningPosition, 'id'>,
  instrument: Instrument,
  baseline: OpeningPosition,
): Promise<void> {
  await updateBook(
    (book) => {
      retainInstrument(book, instrument)
      return maintainOpening(book, id, input, baseline)
    },
    { expectedRevision: bookState.data.revision, saveRecovery: true },
  )
}
/** 删除初始持仓只移除基准记录，不连带删除后续交易。 */
export async function deleteSavedOpening(id: string, expectedRevision: number): Promise<void> {
  await updateBook((book) => maintainOpening(book, id, null), {
    expectedRevision,
    saveRecovery: true,
  })
}
/** 更正资金流水后重新计算历史现金、资产与计划预留。 */
export async function saveCashFlowCorrection(
  id: string,
  input: Omit<CashFlow, 'id' | 'sequence'>,
  baseline: CashFlow,
): Promise<void> {
  await updateBook((book) => maintainCashFlow(book, id, input, baseline), {
    expectedRevision: bookState.data.revision,
    saveRecovery: true,
  })
}
/** 删除资金流水同样检查后续资金是否足够，失败保留原账本。 */
export async function deleteSavedCashFlow(id: string, expectedRevision: number): Promise<void> {
  await updateBook((book) => maintainCashFlow(book, id, null), {
    expectedRevision,
    saveRecovery: true,
  })
}
