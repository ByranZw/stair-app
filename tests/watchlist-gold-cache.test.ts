import { test } from 'node:test'
import assert from 'node:assert/strict'

test('旧银行采样丢弃、上金所参考槽迁移；损坏分时不连带删除银行报价', async () => {
  const id = 'GOLD:CMB-GOLD'
  const quote = {
    instrumentId: id,
    value: '800',
    buyValue: '805',
    date: '2026-11-19 20:00:00',
    source: '招商银行',
    fetchedAt: '2026-11-19T12:00:00Z',
    kind: 'market',
  }
  const referenceHistory = {
    instrumentId: id,
    points: [{ date: '2026-11-19', value: '801' }],
    source: '上金所 Au99.99 · 市场参考收盘价',
    resolution: 'day',
    fetchedAt: quote.fetchedAt,
  }
  const previous = (globalThis as any).uni
  ;(globalThis as any).uni = {
    getStorageSync: (key: string) =>
      key === 'stair.market.v1'
        ? {
            [id]: {
              quote,
              history: {
                instrumentId: id,
                source: '银行本机采样',
                points: [{ date: '2026-11-19', value: '800' }],
              },
              minute: {
                instrumentId: id,
                source: '银行本机采样',
                points: [{ date: '2026-11-19 20:00', value: '800' }],
              },
              referenceHistory,
              referenceMinute: {
                ...referenceHistory,
                resolution: 'minute',
                points: [{ date: 'bad', value: 'not-a-number' }],
              },
            },
          }
        : [],
  }
  try {
    const { watchState, refreshGoldHistory } = await import('../src/state/watchlist')
    assert.deepEqual(JSON.parse(JSON.stringify(watchState.cache[id].quote)), quote)
    assert.deepEqual(JSON.parse(JSON.stringify(watchState.cache[id].history)), referenceHistory)
    assert.equal(watchState.cache[id].minute, undefined)
    assert.equal('referenceHistory' in watchState.cache[id], false)
    const gold = { id, code: 'CMB-GOLD', name: '招行黄金账户', type: 'GOLD' as const }
    const minute = {
      ...referenceHistory,
      resolution: 'minute' as const,
      fetchedAt: new Date().toISOString(),
      points: [{ date: '2026-11-19 20:00', value: '802' }],
    }
    watchState.cache[id].minute = minute
    // 有效分钟缓存60秒内复用，无需网络和写存储。
    await refreshGoldHistory(gold, true)
    assert.equal(watchState.errors[id + '/minute'], undefined)
    assert.deepEqual(JSON.parse(JSON.stringify(watchState.cache[id].minute)), minute)
    // 请求失败后冷却期间不再覆盖错误，也不清除已缓存的曲线和银行报价。
    await refreshGoldHistory(gold)
    assert.ok(watchState.errors[id + '/history'])
    watchState.errors[id + '/history'] = '冷却期保留的来源错误'
    await refreshGoldHistory(gold)
    assert.equal(watchState.errors[id + '/history'], '冷却期保留的来源错误')
    assert.deepEqual(JSON.parse(JSON.stringify(watchState.cache[id].quote)), quote)
    assert.deepEqual(JSON.parse(JSON.stringify(watchState.cache[id].history)), referenceHistory)
  } finally {
    ;(globalThis as any).uni = previous
  }
})
