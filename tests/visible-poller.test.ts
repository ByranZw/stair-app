import test from 'node:test'
import assert from 'node:assert/strict'
import { createVisiblePoller } from '../src/services/visible-poller'

/** 刷新完成的Promise任务先出队，再检查是否创建了下一次定时。 */
async function flush(): Promise<void> {
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

test('前台立即请求且重复启动幂等，完成后间隔刷新，停止后不再请求', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const poller = createVisiblePoller(async () => {
    calls++
  }, 30000)
  poller.start()
  poller.start()
  assert.equal(calls, 1)
  await flush()
  t.mock.timers.tick(29999)
  assert.equal(calls, 1)
  t.mock.timers.tick(1)
  assert.equal(calls, 2)
  await flush()
  poller.stop()
  t.mock.timers.tick(90000)
  assert.equal(calls, 2)
})

test('慢请求不重叠，停止后的迟到完成不会重新排定', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0,
    finish!: () => void
  const poller = createVisiblePoller(() => {
    calls++
    return new Promise<void>((resolve) => {
      finish = resolve
    })
  })
  poller.start()
  t.mock.timers.tick(90000)
  assert.equal(calls, 1)
  poller.stop()
  finish()
  await flush()
  t.mock.timers.tick(90000)
  assert.equal(calls, 1)
})

test('在途退出再返回等待旧请求，完成后只接续一次新会话', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0,
    finish!: () => void
  const poller = createVisiblePoller(() => {
    calls++
    if (calls === 1)
      return new Promise<void>((resolve) => {
        finish = resolve
      })
    return Promise.resolve()
  })
  poller.start()
  poller.stop()
  poller.start()
  poller.start()
  assert.equal(calls, 1)
  finish()
  await flush()
  assert.equal(calls, 2)
  t.mock.timers.tick(30000)
  assert.equal(calls, 3)
  await flush()
  poller.stop()
})

test('刷新失败后按间隔重试，停止仍能清除下一轮', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let calls = 0
  const poller = createVisiblePoller(async () => {
    calls++
    throw new Error('模拟来源失败')
  })
  poller.start()
  await flush()
  t.mock.timers.tick(30000)
  assert.equal(calls, 2)
  await flush()
  poller.stop()
  t.mock.timers.tick(30000)
  assert.equal(calls, 2)
})
