import type { Instrument } from '../domain/market'
import { parseFund, record } from './parsers'

/** 来源实际最多每页20条，按返回页码顺序回补，重复页/中途失败不能冒充完整覆盖。 */
export async function readFundHistory(
  instrument: Instrument,
  count: number,
  readPage: (page: number) => Promise<unknown>,
) {
  const rows: unknown[] = []
  const seen = new Set<string>()
  const maxPages = Math.ceil(Math.min(640, count) / 20)
  for (let page = 1; page <= maxPages; page++) {
    const body = record(await readPage(page))
    const parsed = parseFund(body, instrument)
    if (Number(body.PageIndex) !== page) throw new Error('正式净值来源页码不一致，请稍后刷新')
    const pageRows = record(body.Data).LSJZList as unknown[]
    if (parsed.history.points.some((point) => seen.has(point.date)))
      throw new Error('正式净值来源返回重复页，已保留原缓存')
    for (const point of parsed.history.points) seen.add(point.date)
    rows.push(...pageRows)
    if (pageRows.length < 20 || rows.length >= Number(body.TotalCount)) break
  }
  return parseFund({ ErrCode: 0, Data: { LSJZList: rows } }, instrument)
}
