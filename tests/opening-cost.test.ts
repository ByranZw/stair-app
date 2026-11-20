import { test } from 'node:test'
import assert from 'node:assert/strict'
import { openingCost } from '../src/domain/opening-cost'

test('按成本价导入按份额或克重换算总成本，并按分四舍五入', () => {
  assert.equal(openingCost('10', '780', 'unit').totalCost, '7800.00')
  assert.equal(openingCost('1234.56', '1.2345', 'unit').totalCost, '1524.06')
  assert.equal(openingCost('0.01', '0.5', 'unit').totalCost, '0.01')
})

test('切换总成本反算保留精度，来回切换不改变原总成本', () => {
  const cost = openingCost('99999999', '1000000.01', 'total')
  assert.equal(openingCost('99999999', cost.unitCost, 'unit').totalCost, '1000000.01')
  assert.equal(openingCost('3', '100', 'total').totalCost, '100.00')
  const small = openingCost('999999999999', '0.01', 'total')
  assert.equal(openingCost('999999999999', small.unitCost, 'unit').totalCost, '0.01')
})

test('非法数量、成本、超限金额及不足一分的总成本阻止导入', () => {
  for (const [qty, value] of [
    ['0', '780'],
    ['', '780'],
    ['10', '-1'],
    ['10', 'NaN'],
    ['999999999999', '780'],
    ['0.00000001', '0.00000001'],
  ])
    assert.throws(() => openingCost(qty, value, 'unit'))
  assert.throws(() => openingCost('10', '100.001', 'total'))
})
