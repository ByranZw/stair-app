import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchLatestRelease } from '../src/state/app-update'
import { RELEASE_API, RELEASE_MANIFEST } from '../src/domain/app-update'

/** 只替换传输回调，不模拟账本、原生版本或下载校验。 */
function transport(responses: Array<number | 'network'>) {
  const globals = globalThis as unknown as { uni: typeof uni }
  const original = globals.uni
  const urls: string[] = []
  globals.uni = {
    request: (options: UniNamespace.RequestOptions) => {
      urls.push(options.url)
      const response = responses.shift()
      if (response === 'network') options.fail?.({ errMsg: 'offline' })
      else
        options.success?.({
          statusCode: response!,
          data: { marker: 'release' },
          header: {},
          cookies: [],
        })
      return { abort() {} }
    },
  } as unknown as typeof uni
  return {
    urls,
    restore: () => {
      globals.uni = original
    },
  }
}

test('更新清单成功不调用公共API', async () => {
  const mock = transport([200])
  try {
    assert.deepEqual(await fetchLatestRelease(), { marker: 'release' })
    assert.deepEqual(mock.urls, [RELEASE_MANIFEST])
  } finally {
    mock.restore()
  }
})

test('仅清单404回退一次旧版API', async () => {
  const mock = transport([404, 200])
  try {
    await fetchLatestRelease()
    assert.deepEqual(mock.urls, [RELEASE_MANIFEST, RELEASE_API])
  } finally {
    mock.restore()
  }
})

for (const status of [403, 429, 500, 'network'] as const) {
  test(`更新清单失败${status}不伪装成功也不重试`, async () => {
    const mock = transport([status])
    try {
      await assert.rejects(
        fetchLatestRelease(),
        status === 'network' ? /无法连接GitHub/ : status === 500 ? /HTTP 500/ : /限流/,
      )
      assert.deepEqual(mock.urls, [RELEASE_MANIFEST])
    } finally {
      mock.restore()
    }
  })
}

test('清单与API均404时终止，不递归重试', async () => {
  const mock = transport([404, 404])
  try {
    await assert.rejects(fetchLatestRelease(), /HTTP 404/)
    assert.equal(mock.urls.length, 2)
  } finally {
    mock.restore()
  }
})
