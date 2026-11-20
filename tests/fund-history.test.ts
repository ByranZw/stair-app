import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFundHistory } from '../src/services/fund-history'
import type { Instrument } from '../src/domain/market'

const fund: Instrument = { id: 'FUND:110022', code: '110022', name: '测试基金', type: 'FUND' }
/** 按来源的实际20条分页返回正式净值，末页不足20条。 */
function pageData(page: number) {
  return {
    ErrCode: 0,
    PageIndex: page,
    TotalCount: 45,
    Data: {
      LSJZList: Array.from({ length: page === 3 ? 5 : 20 }, (_, index) => ({
        FSRQ: new Date(Date.parse('2026-11-19') - ((page - 1) * 20 + index) * 86400000)
          .toISOString()
          .slice(0, 10),
        DWJZ: '1.0100',
      })),
    },
  }
}
test('净值实际按20条分页回补，末页停止且报价仍属最新披露日', async () => {
  const requested: number[] = []
  const result = await readFundHistory(fund, 180, async (page) => {
    requested.push(page)
    return pageData(page)
  })
  assert.deepEqual(requested, [1, 2, 3])
  assert.equal(result.history.points.length, 45)
  assert.equal(result.quote.date, '2026-11-19')
  assert.equal(result.history.points[0].date, '2026-10-06')
})
test('来源重复页与后续失败拒绝整次覆盖，不用首20条冒充成功', async () => {
  await assert.rejects(
    readFundHistory(fund, 180, async (page) => ({ ...pageData(1), PageIndex: page })),
    /重复页/,
  )
  await assert.rejects(
    readFundHistory(fund, 180, async (page) => {
      if (page === 2) throw Error('网络失败')
      return pageData(page)
    }),
    /网络失败/,
  )
  await assert.rejects(
    readFundHistory(fund, 180, async () => pageData(2)),
    /页码不一致/,
  )
})
