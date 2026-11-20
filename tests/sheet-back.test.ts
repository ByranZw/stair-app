import test from 'node:test'
import assert from 'node:assert/strict'
import { createSheetBackStack } from '../src/services/sheet-back'

test('返回优先关闭顶层，退场完成前不穿透，全部关闭后允许页面返回', () => {
  const stack = createSheetBackStack()
  const calls: string[] = []
  const releaseFirst = stack.register(() => calls.push('first'))
  const releaseSecond = stack.register(() => calls.push('second'))
  assert.equal(stack.back(), true)
  assert.equal(stack.back(), true)
  assert.deepEqual(calls, ['second', 'second'])
  releaseSecond()
  assert.equal(stack.back(), true)
  assert.deepEqual(calls, ['second', 'second', 'first'])
  releaseFirst()
  assert.equal(stack.back(), false)
})

test('关闭被表单拒绝仍消费返回，后台浮层卸载不打乱顶层', () => {
  const stack = createSheetBackStack()
  const releaseFirst = stack.register(() => assert.fail('不能关闭下层'))
  let attempts = 0
  const releaseSecond = stack.register(() => attempts++)
  releaseFirst()
  releaseFirst()
  assert.equal(stack.back(), true)
  assert.equal(stack.back(), true)
  assert.equal(attempts, 2)
  releaseSecond()
  assert.equal(stack.back(), false)
})
