import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseEtf,
  parseFund,
  parseSearch,
  parseGoldDiagnostic,
  price,
  marketDate,
} from '../src/services/parsers'
import type { Instrument } from '../src/domain/market'

/** 测试使用已保存的公开接口样本，避免来源变化使回归测试不稳定。 */
function fixture(name: string) {
  return JSON.parse(readFileSync(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'))
}
const etf: Instrument = {
  id: 'ETF:510300',
  code: '510300',
  name: '沪深300ETF华泰柏瑞',
  type: 'ETF',
  market: 'sh',
}
const fund: Instrument = {
  id: 'FUND:110022',
  code: '110022',
  name: '易方达消费行业股票',
  type: 'FUND',
}

test('目录结果保留ETF交易所，场外筛选不混入ETF', () => {
  assert.deepEqual(parseSearch(fixture('search-etf'), 'ETF'), [etf])
  assert.deepEqual(parseSearch(fixture('search-etf'), 'FUND'), [])
})
test('ETF联接仍归基金；股票不因同名进入目录', () => {
  const raw = {
    ErrCode: 0,
    Datas: [
      { CODE: '110020', NAME: '某某ETF联接A', FundBaseInfo: { FCODE: '110020' } },
      { CODE: '600000', NAME: '某某ETF股票' },
    ],
  }
  assert.equal(parseSearch(raw, 'FUND').length, 1)
  assert.equal(parseSearch(raw, 'ETF').length, 0)
})
test('腾讯即时价取qt字段，日线取未复权收盘列，按日期排序', () => {
  const raw = fixture('etf'),
    result = parseEtf(raw, etf)
  assert.equal(result.quote.value, raw.data.sh510300.qt.sh510300[3])
  assert.equal(result.history.points[0].value, raw.data.sh510300.day[0][2])
  assert.match(result.quote.date, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
})
test('ETF代码不匹配拒绝入库，不以另一标的行情填充', () => {
  const raw = fixture('etf')
  raw.data.sh510300.qt.sh510300[2] = '510500'
  assert.throws(() => parseEtf(raw, etf), /代码与报价不一致/)
})
test('来源错误与无净值不是成功空数据', () => {
  assert.throws(() => parseFund({ ErrCode: -999, Data: '' }, fund), /暂不可用/)
  assert.throws(() => parseFund({ ErrCode: 0, Data: { LSJZList: [] } }, fund), /尚无可用正式净值/)
  assert.throws(() => parseEtf({ code: 1 }, etf), /暂不可用/)
})
test('招行候选报价只返回原字段，不伪造可估值Quote', () => {
  const result = parseGoldDiagnostic({
    code: 'SUC0000',
    success: true,
    data: { NowTime: '2026/11/18 21:10:51', FQAMBPRCZ1: { zBuyPrc: '811.46', zSelPrc: '806.46' } },
  })
  assert.deepEqual(result, { buyField: '811.46', sellField: '806.46', time: '2026/11/18 21:10:51' })
  assert.equal('instrumentId' in result, false)
  assert.throws(() => parseGoldDiagnostic({ code: 'FAILED', success: false }), /暂不可用/)
})
test('拒绝无效价格及会自动滚动的非法日期', () => {
  for (const value of ['', null, '--', 'NaN', 'Infinity', '-1', '0'])
    assert.throws(() => price(value))
  assert.equal(price('3.0100'), '3.0100')
  assert.throws(() => marketDate('2026-02-31'))
  assert.equal(marketDate('2024-02-29'), '2024-02-29')
})
test('基金按正式净值所属日确定最新值，盘中估值不参与', () => {
  const raw = fixture('fund')
  raw.gsz = '9999'
  raw.Data.LSJZList.reverse()
  const result = parseFund(raw, fund)
  const latest = [...raw.Data.LSJZList].sort((a, b) => b.FSRQ.localeCompare(a.FSRQ))[0]
  assert.equal(result.quote.date, latest.FSRQ)
  assert.equal(result.quote.value, latest.DWJZ)
  assert.equal(result.quote.kind, 'nav')
  assert.notEqual(result.quote.value, '9999')
})
