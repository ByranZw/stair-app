import test from 'node:test'
import assert from 'node:assert/strict'
import { utf8Bytes } from '../src/domain/encoding'
import { createBackup, readBackup } from '../src/domain/backup'
import { emptyBook } from '../src/domain/book'

test('跨端UTF-8与标准编码器逐字节一致，覆盖中文、四字节字符和孤立代理项', () => {
  for (const text of [
    '',
    '拾阶账户😀',
    '\0\x7f\u0080\u07ff\u0800\uffff',
    '\ud800X\udfff',
    '\u{10ffff}',
  ])
    assert.deepEqual(utf8Bytes(text), new TextEncoder().encode(text))
})

test('无TextEncoder的原生逻辑环境仍能导出校验并恢复原有备份，哈希口径不变', () => {
  const book = emptyBook()
  book.accounts = [{ id: 'a', name: '黄金账户😀', date: '2026-01-01', openingCash: '10.00' }]
  const original = createBackup(book, '2026-11-19T00:00:00Z')
  const encoder = globalThis.TextEncoder
  try {
    Reflect.deleteProperty(globalThis, 'TextEncoder')
    assert.equal(createBackup(book, '2026-11-19T00:00:00Z'), original)
    assert.deepEqual(readBackup(original).book, book)
  } finally {
    globalThis.TextEncoder = encoder
  }
})
