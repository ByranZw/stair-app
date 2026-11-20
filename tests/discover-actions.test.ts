import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { emptyBook } from '../src/domain/book'
import { parseCorporateHints } from '../src/services/corporate-hints'
import { discoverActions } from '../src/domain/discover-actions'
import { projectBook, recordCorporateAction } from '../src/domain/ledger'
const instrument = {
  id: 'ETF:510300',
  type: 'ETF' as const,
  market: 'sh' as const,
  code: '510300',
  name: '测试ETF',
}
const html = readFileSync(new URL('./fixtures/fund-actions.html', import.meta.url), 'utf8')

test('真实公告按每10份换算每份，拆分比例按后/前，代码不匹配或结构变化不能当成无事件', () => {
  const hints = parseCorporateHints(html, instrument)
  assert.equal(hints.at(-1)?.date, '2026-01-19')
  assert.equal(hints.at(-1)?.cashPerShare, '0.123')
  assert.equal(hints.at(-1)?.paymentDate, '2026-01-27')
  assert.equal(hints.find((h) => h.type === 'split')?.ratio, '0.3709')
  assert.throws(() => parseCorporateHints(html, { ...instrument, code: '110022' }), /代码不一致/)
  assert.throws(
    () => parseCorporateHints(html.replace('每10份分红', '结构变更'), instrument),
    /表结构/,
  )
})

test('公告只对生效前持仓登记待核对，不变动现金；重复刷新/已确认不重复，导入基准前不重放', () => {
  const book = emptyBook()
  book.accounts = [{ id: 'a', name: '测试', date: '2026-01-01', openingCash: '50000' }]
  book.instruments = [instrument]
  book.openings = [
    {
      id: 'o',
      accountId: 'a',
      instrumentId: instrument.id,
      date: '2026-01-02',
      qty: '100',
      totalCost: '1000',
    },
  ]
  const hints = parseCorporateHints(html, instrument)
  const next = discoverActions(book, instrument.id, hints)
  assert.equal(next.corporateActions?.length, 1)
  assert.equal(next.corporateActions![0].status, 'pending')
  assert.equal(next.corporateActions![0].referenceQty, '100')
  assert.equal(projectBook(next).cash.a, '50000.00')
  assert.equal(discoverActions(next, instrument.id, hints), next)
  const done = recordCorporateAction(next, {
    ...next.corporateActions![0],
    status: 'confirmed',
    cashAmount: '12.3',
    orderConfirmed: true,
  })
  assert.equal(discoverActions(done, instrument.id, hints), done)
  assert.equal(projectBook(done).cash.a, '50012.30')
  const later = { ...book, openings: [{ ...book.openings[0], date: '2026-02-01' }] }
  assert.equal(discoverActions(later, instrument.id, hints), later)
})

test('明确暂无权益才能返回空列表，同日多项权益不能忽略其中一项', () => {
  const empty = readFileSync(new URL('./fixtures/fund-actions-empty.html', import.meta.url), 'utf8')
  assert.deepEqual(
    parseCorporateHints(empty, { id: 'FUND:110022', code: '110022', name: '测试', type: 'FUND' }),
    [],
  )
  const duplicate = html.replace('2012-05-11', '2026-01-19')
  assert.throws(() => parseCorporateHints(duplicate, instrument), /同日多项权益/)
})
