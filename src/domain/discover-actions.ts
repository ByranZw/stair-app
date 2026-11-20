import type { Book } from './book'
import type { CorporateHint } from './market'
import { D, today } from './money'
import { projectBook, recordCorporateAction } from './ledger'
import { sha256 } from '@noble/hashes/sha256'
import { bytesToHex } from '@noble/hashes/utils'
import { utf8Bytes } from './encoding'

/** 公开公告只登记可能涉及本账户的待核对事件，资金与数量必须由用户实际确认。 */
export function discoverActions(book: Book, instrumentId: string, hints: CorporateHint[]): Book {
  let next = book
  for (const account of book.accounts) {
    const opening = book.openings.find(
      (o) => o.accountId === account.id && o.instrumentId === instrumentId,
    )
    for (const hint of hints) {
      if (hint.date < account.date || hint.date > today() || (opening && hint.date <= opening.date))
        continue
      if (
        (next.corporateActions || []).some(
          (a) =>
            a.accountId === account.id && a.instrumentId === instrumentId && a.date === hint.date,
        )
      )
        continue
      // 生效日开盘前持仓是提示值；登记日权属、红利方式及实际到账仍需银行确认。
      const before: Book = {
        ...next,
        openings: next.openings.filter((o) => o.date < hint.date),
        trades: next.trades.filter((t) => t.date < hint.date),
        cashFlows: next.cashFlows.filter((f) => f.date < hint.date),
        corporateActions: (next.corporateActions || []).filter((a) => a.date < hint.date),
      }
      const previousDate = new Date(Date.parse(hint.date) - 86400000).toISOString().slice(0, 10)
      const qty = projectBook(before, previousDate).positions[`${account.id}/${instrumentId}`]?.qty
      if (!qty || new D(qty).lte(0)) continue
      next = recordCorporateAction(next, {
        id: 'public-' + bytesToHex(sha256(utf8Bytes(`${account.id}/${instrumentId}/${hint.date}`))),
        accountId: account.id,
        instrumentId,
        date: hint.date,
        cashDate: hint.paymentDate,
        type: hint.type,
        status: 'pending',
        referenceQty: qty,
        cashPerShare: hint.cashPerShare,
        ratio: hint.ratio,
        cashAmount: '',
        addedQty: '',
        orderConfirmed: false,
        source: hint.source + (hint.paymentDate ? `；公告发放日${hint.paymentDate}` : ''),
      })
    }
  }
  return next
}
