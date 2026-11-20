import { D } from '../domain/money'
import type { CorporateHint, Instrument } from '../domain/market'

/** 只取公告表格的纯文本，不执行或渲染供应方HTML。 */
function plain(html: string): string {
  return html
    .replace(/<[^>]*>/g, '')
    .replace(/&nbsp;|&#160;/g, '')
    .trim()
}
/** 外部公告日期必须为真实日历日，不能默默归一化无效日期。 */
function date(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(value).toISOString().slice(0, 10) !== value)
    throw new Error('权益公告日期无效，请手动核对')
  return value
}
/** 解析固定分红/折算两张表；标的或表结构变化时拒绝当成无事件。 */
export function parseCorporateHints(html: string, instrument: Instrument): CorporateHint[] {
  if (!/^\d{6}$/.test(instrument.code) || instrument.type === 'GOLD')
    throw new Error('权益公告标的类型无效')
  const title = html.match(/<title>([\s\S]*?)<\/title>/i)?.[1] || ''
  if (!title.includes(`(${instrument.code})基金分红送配`))
    throw new Error('权益公告与标的代码不一致')
  const hints: CorporateHint[] = []
  const source = `东方财富 · ${instrument.code}分红送配公告`
  for (const type of ['dividend', 'split'] as const) {
    const name = type === 'dividend' ? 'cfxq' : 'fhxq'
    const table = [...html.matchAll(/<table\b[^>]*>[\s\S]*?<\/table>/gi)].find((m) =>
      new RegExp(`class=['"][^'"]*\\b${name}\\b`).test(m[0]),
    )?.[0]
    const header = table?.match(/<thead>[\s\S]*?<\/thead>/i)?.[0] || ''
    if (!table || !header.includes(type === 'dividend' ? '每10份分红' : '拆分折算比例'))
      throw new Error('权益公告表结构变化，请手动核对')
    const rows = table.match(/<tbody>([\s\S]*?)<\/tbody>/i)?.[1]
    if (!rows) throw new Error('权益公告缺少明细，请手动核对')
    if (/暂无分红|暂无拆分|暂无折算/.test(plain(rows))) continue
    if (!/<tr\b/i.test(rows)) throw new Error('权益公告缺少明细，请手动核对')
    for (const row of rows.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)) {
      const cells = [...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map((c) => plain(c[1]))
      if (type === 'dividend') {
        const cash = cells[3]?.match(/^每10份派现金(\d+(?:\.\d+)?)元$/)?.[1]
        if (cells.length !== 5 || !cash || new D(cash).lte(0))
          throw new Error('分红公告金额无法识别，请手动核对')
        hints.push({
          type,
          date: date(cells[2]),
          registrationDate: date(cells[1]),
          paymentDate: date(cells[4]),
          cashPerShare: new D(cash).div(10).toString(),
          ratio: '',
          source,
        })
      } else {
        const ratio = cells[3]?.match(/^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/)
        if (cells.length !== 4 || !ratio || new D(ratio[1]).lte(0) || new D(ratio[2]).lte(0))
          throw new Error('折算公告比例无法识别，请手动核对')
        hints.push({
          type,
          date: date(cells[1]),
          cashPerShare: '',
          ratio: new D(ratio[2]).div(ratio[1]).toString(),
          source,
        })
      }
    }
  }
  if (new Set(hints.map((hint) => hint.date)).size !== hints.length)
    throw new Error('同日多项权益暂不支持自动处理，请核对公告并暂停计划')
  return hints.sort((a, b) => a.date.localeCompare(b.date))
}
