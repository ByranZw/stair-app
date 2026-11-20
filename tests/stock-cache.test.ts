import test from 'node:test'
import assert from 'node:assert/strict'
import fixtures from './fixtures/stock-markets.json'
import { stockInstrument } from '../src/services/stocks'
import type { Quote } from '../src/domain/market'

/** 真实请求入口控制完成顺序，验证刷新与历史回补共用的缓存不被较旧汇率覆盖。 */
test('股票刷新与历史回补交错时，缓存股价和汇率分别不倒退', async (t) => {
  t.mock.method(Date, 'now', () => Date.parse('2026-11-20T12:30:00+08:00'))
  const previousUni = (globalThis as any).uni
  const pending: any[] = []
  const saved: Record<string, unknown> = {}
  ;(globalThis as any).uni = {
    getStorageSync: () => undefined,
    setStorageSync: (key: string, value: unknown) => {
      saved[key] = value
    },
    request: (options: any) => {
      pending.push(options)
    },
  }
  try {
    const { watchState, refreshInstrument, loadMoreHistory } =
      await import('../src/state/watchlist')
    const item = stockInstrument('hk', '00700', '腾讯控股')
    const quote: Quote = {
      instrumentId: item.id,
      value: '344',
      previous: '348.4',
      date: '2026-11-20 16:08:37',
      fetchedAt: '2026-11-20T04:00:00Z',
      source: '测试缓存',
      kind: 'market',
      currency: 'HKD',
      fxRate: '0.9',
      fxDate: '2026-11-20 11:00:00',
    }
    /** 每一场景复用同一初始缓存，只改变两个真实网络请求的完成时点。 */
    const reset = () => {
      pending.length = 0
      watchState.cache[item.id] = {
        quote: { ...quote },
        history: { instrumentId: item.id, points: [], source: '测试', fetchedAt: quote.fetchedAt },
      }
      delete watchState.errors[item.id]
      delete watchState.errors[item.id + '/history']
    }
    /** 腾讯和汇率响应通过生产传输与解析器进入缓存，不直接调用合并实现。 */
    const finish = (batch: any[], time: string, rate: string) => {
      for (const options of batch) {
        const raw = options.url.includes('/list=')
          ? `var hq_str_fx_shkdcny="${time},${rate},${rate},${rate},0,${rate},${rate},${rate},${rate},人民币,0,0,0,来源,0,0,,2026-11-20";`
          : JSON.stringify({ code: 0, data: { hk00700: fixtures[2].node } })
        options.success({ statusCode: 200, data: raw })
      }
    }
    reset()
    const refresh = refreshInstrument(item)
    finish(pending.splice(0), '10:00:00', '0.8')
    await refresh
    assert.equal(watchState.cache[item.id].quote.fxRate, '0.9')
    assert.match(watchState.errors[item.id], /较旧报价或汇率/)
    reset()
    const history = loadMoreHistory(item)
    finish(pending.splice(0), '10:00:00', '0.8')
    await history
    assert.equal(watchState.cache[item.id].quote.fxDate, quote.fxDate)
    assert.ok(watchState.cache[item.id].history.points.length > 0)
    reset()
    const slowHistory = loadMoreHistory(item),
      historyBatch = pending.splice(0)
    const fastRefresh = refreshInstrument(item),
      refreshBatch = pending.splice(0)
    finish(refreshBatch, '12:00:00', '0.95')
    await fastRefresh
    finish(historyBatch, '11:30:00', '0.92')
    await slowHistory
    assert.equal(watchState.cache[item.id].quote.fxRate, '0.95')
    assert.equal(watchState.cache[item.id].quote.fxDate, '2026-11-20 12:00:00')
    assert.equal((saved['stair.market.v1'] as any)[item.id].quote.fxRate, '0.95')
  } finally {
    ;(globalThis as any).uni = previousUni
  }
})
