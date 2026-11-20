import test from 'node:test'
import assert from 'node:assert/strict'
import { createDialogController } from '../src/services/dialog'

test('确认退场完成后只结算一次，下一次请求不继承旧答案', async () => {
  const dialog = createDialogController()
  let executed = false
  const result = dialog.confirm({ title: '删除持仓？', destructive: true }).then((value) => {
    executed = value
    return value
  })
  dialog.answer(true)
  assert.equal(dialog.visible.value, false)
  assert.equal(dialog.request.value?.title, '删除持仓？')
  await Promise.resolve()
  assert.equal(executed, false)
  dialog.answer(false)
  dialog.finish()
  dialog.finish()
  assert.equal(await result, true)
  assert.equal(dialog.request.value, undefined)
  const next = dialog.confirm({ title: '替换账本？' })
  dialog.answer(false)
  dialog.finish()
  assert.equal(await next, false)
})

test('重复点击不能替换待确认记录，取消只影响当前请求', async () => {
  const dialog = createDialogController()
  const first = dialog.confirm({ title: '记录A' })
  assert.equal(await dialog.confirm({ title: '记录B' }), false)
  assert.equal(dialog.request.value?.title, '记录A')
  dialog.answer(false)
  dialog.finish()
  assert.equal(await first, false)
})

test('隐藏或卸载页面取消尚未执行的确认，重新打开可正常使用', async () => {
  const dialog = createDialogController()
  const first = dialog.confirm({ title: '删除记录' })
  dialog.answer(true)
  dialog.cancel()
  assert.equal(await first, false)
  assert.equal(dialog.visible.value, false)
  const second = dialog.confirm({ title: '再次编辑' })
  dialog.cancel()
  assert.equal(await second, false)
})
