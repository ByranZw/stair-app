import test from 'node:test'
import assert from 'node:assert/strict'
import { pickerDate, pickerDateColumns } from '../src/domain/picker-date'
import { formatDateTime } from '../src/domain/display-time'

test('月末切换不跨月，正确处理闰年', () => {
  assert.equal(pickerDate([2024, 2, 31], '1900-01-01', '2100-12-31'), '2024-02-29')
  assert.equal(pickerDate([2025, 2, 31], '1900-01-01', '2100-12-31'), '2025-02-28')
  assert.equal(pickerDate([2026, 4, 31], '1900-01-01', '2100-12-31'), '2026-04-30')
})

test('可选日期首尾联动，不允许选择范围外的日期', () => {
  assert.equal(pickerDate([2026, 12, 31], '2025-03-15', '2026-11-20'), '2026-11-20')
  assert.equal(pickerDate([2024, 1, 1], '2025-03-15', '2026-11-20'), '2025-03-15')
  const first = pickerDateColumns('2025-03-15', '2025-03-15', '2026-11-20')
  assert.deepEqual(first[0], [2025, 2026])
  assert.equal(first[1][0], 3)
  assert.equal(first[2][0], 15)
  const last = pickerDateColumns('2026-11-20', '2025-03-15', '2026-11-20')
  assert.equal(last[1].at(-1), 11)
  assert.equal(last[2].at(-1), 20)
})

test('时间显示不依赖设备的本地化实现，并按设备时区补零', () => {
  const date = new Date(2026, 0, 2, 3, 4)
  const original = Date.prototype.toLocaleString
  Date.prototype.toLocaleString = () => 'Fri Nov 20 xxx'
  try {
    assert.equal(formatDateTime(date.toISOString()), '2026年01月02日 03:04')
    assert.equal(formatDateTime('invalid'), '—')
  } finally {
    Date.prototype.toLocaleString = original
  }
})
