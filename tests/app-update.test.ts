import test from 'node:test'
import assert from 'node:assert/strict'
import {
  compareVersions,
  MAX_APK_BYTES,
  parseRelease,
  RELEASE_API,
  RELEASE_HOME,
  UPDATE_INTERVAL,
} from '../src/domain/app-update'
import {
  createUpdater,
  type UpdateDependencies,
  type UpdateState,
} from '../src/services/update-controller'

/** 固定正式发布夹具，每次创建独立资产，避免无效响应用例相互污染。 */
function releaseFixture() {
  return {
    tag_name: 'v0.1.14',
    html_url: 'https://github.com/ByranZw/stair-app/releases/tag/v0.1.14',
    draft: false,
    prerelease: false,
    body: '新增应用内更新与安装包完整性校验。',
    assets: [
      {
        name: 'stair-0.1.14-arm64.apk',
        browser_download_url:
          'https://github.com/ByranZw/stair-app/releases/download/v0.1.14/stair-0.1.14-arm64.apk',
        state: 'uploaded',
        size: 4096,
        digest: `sha256:${'AB'.repeat(32)}`,
      },
    ],
  }
}

/** 手动完成异步边界，不用网络、真实下载或计时等待复现并发次序。 */
function deferred<Value>() {
  let resolve!: (value: Value | PromiseLike<Value>) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<Value>((finish, fail) => {
    resolve = finish
    reject = fail
  })
  return { promise, resolve, reject }
}

/** 原生与持久化边界全部替换为内存夹具，记录用户动作实际触发的副作用。 */
function updaterFixture(overrides: Partial<UpdateDependencies> = {}) {
  const environment = {
    supported: true,
    version: '0.1.13',
    now: Date.parse('2026-11-27T06:00:00Z'),
    lastAttempt: undefined as ReturnType<UpdateDependencies['lastAttempt']>,
  }
  const calls = {
    fetches: 0,
    downloads: [] as Parameters<UpdateDependencies['download']>[0][],
    verifications: [] as Parameters<UpdateDependencies['verify']>[],
    removals: [] as string[],
    installations: [] as [path: string, release: Parameters<UpdateDependencies['install']>[1]][],
    savedAttempts: [] as Parameters<UpdateDependencies['saveAttempt']>[0][],
    cancellations: 0,
    events: [] as string[],
  }
  const state: UpdateState = {
    phase: 'idle',
    currentVersion: environment.version,
    error: '',
    progress: 0,
    readyPath: '',
    permissionNeeded: false,
    installerOpened: false,
    dismissed: false,
  }
  const dependencies: UpdateDependencies = {
    supported: () => environment.supported,
    version: () => environment.version,
    now: () => environment.now,
    lastAttempt: () => environment.lastAttempt,
    saveAttempt: (attempt) => {
      environment.lastAttempt = attempt
      calls.savedAttempts.push(attempt)
    },
    fetchRelease: async () => {
      calls.fetches++
      return releaseFixture()
    },
    download: (release, progress) => {
      calls.downloads.push(release)
      progress(release.size)
      return {
        promise: Promise.resolve('/private/update/stair-0.1.14-arm64.apk'),
        cancel: () => {
          calls.cancellations++
        },
      }
    },
    verify: async (path, release) => {
      calls.verifications.push([path, release])
      calls.events.push('verify')
    },
    remove: (path) => {
      calls.removals.push(path)
    },
    install: async (path, release) => {
      calls.installations.push([path, release])
      calls.events.push('install')
      return 'opened'
    },
    ...overrides,
  }
  return { environment, calls, dependencies, state, updater: createUpdater(dependencies, state) }
}

test('正式版本固定使用本项目GitHub端点，解析出精确ARM64资产和规范化摘要', () => {
  assert.equal(RELEASE_API, 'https://api.github.com/repos/ByranZw/stair-app/releases/latest')
  assert.equal(RELEASE_HOME, 'https://github.com/ByranZw/stair-app/releases')
  assert.deepEqual(parseRelease(releaseFixture()), {
    version: '0.1.14',
    notes: '新增应用内更新与安装包完整性校验。',
    url: 'https://github.com/ByranZw/stair-app/releases/tag/v0.1.14',
    assetUrl:
      'https://github.com/ByranZw/stair-app/releases/download/v0.1.14/stair-0.1.14-arm64.apk',
    size: 4096,
    sha256: 'ab'.repeat(32),
  })
})

for (const [description, invalidRelease] of [
  ['空响应', null],
  ['无响应', undefined],
  ['缺失正式标识', {}],
  ['草稿版本', { ...releaseFixture(), draft: true }],
  ['预发布版本', { ...releaseFixture(), prerelease: true }],
  ['缺失预发布标识', { ...releaseFixture(), prerelease: undefined }],
] as const) {
  test(`非正式发布被拒绝：${description}`, () => {
    assert.throws(() => parseRelease(invalidRelease), /正式版本/)
  })
}

for (const tag of ['0.1.14', 'v0.1.14-beta.1', 'v01.1.14', 'v0.1', 'v0.1.14.1']) {
  test(`发布标签必须是带v前缀的三段正式版本：${tag}`, () => {
    assert.throws(() => parseRelease({ ...releaseFixture(), tag_name: tag }), /版本号格式/)
  })
}

for (const source of [
  'https://github.com/other/stair-app/releases/tag/v0.1.14',
  'https://github.com/ByranZw/stair-app/releases/tag/v0.1.13',
  'https://github.com.evil.example/ByranZw/stair-app/releases/tag/v0.1.14',
  'http://github.com/ByranZw/stair-app/releases/tag/v0.1.14',
]) {
  test(`拒绝非固定正式发布页面：${source}`, () => {
    assert.throws(() => parseRelease({ ...releaseFixture(), html_url: source }), /来源/)
  })
}

for (const filename of [
  'stair-0.1.13-arm64.apk',
  'stair-0.1.14-arm.apk',
  'stair-0.1.14-x64.apk',
  'stair-0.1.14-arm64.apk.exe',
  'Stair-0.1.14-arm64.apk',
]) {
  test(`安装包文件名必须精确匹配正式版本与架构：${filename}`, () => {
    const release = releaseFixture()
    release.assets[0].name = filename
    assert.throws(() => parseRelease(release), /唯一的ARM64/)
  })
}

test('缺少资产列表、目标资产缺失或重名资产不能进入下载', () => {
  assert.throws(() => parseRelease({ ...releaseFixture(), assets: undefined }), /安装包信息/)
  assert.throws(() => parseRelease({ ...releaseFixture(), assets: [] }), /唯一的ARM64/)
  const release = releaseFixture()
  release.assets.push({ ...release.assets[0] })
  assert.throws(() => parseRelease(release), /唯一的ARM64/)
})

test('其他架构和空资产不会替代唯一的精确ARM64资产', () => {
  const release = releaseFixture()
  assert.equal(
    parseRelease({
      ...release,
      assets: [null, { ...release.assets[0], name: 'stair-0.1.14-arm.apk' }, ...release.assets],
    }).assetUrl,
    release.assets[0].browser_download_url,
  )
})

for (const source of [
  'https://github.com/other/stair-app/releases/download/v0.1.14/stair-0.1.14-arm64.apk',
  'https://github.com/ByranZw/stair-app/releases/download/v0.1.13/stair-0.1.14-arm64.apk',
  'https://github.com/ByranZw/stair-app/releases/download/v0.1.14/stair-0.1.14-arm64.apk?download=1',
  'https://github.com.evil.example/ByranZw/stair-app/releases/download/v0.1.14/stair-0.1.14-arm64.apk',
  'http://github.com/ByranZw/stair-app/releases/download/v0.1.14/stair-0.1.14-arm64.apk',
]) {
  test(`拒绝非精确GitHub资产来源：${source}`, () => {
    const release = releaseFixture()
    release.assets[0].browser_download_url = source
    assert.throws(() => parseRelease(release), /下载来源/)
  })
}

test('尚未上传完成的资产不能下载', () => {
  const release = releaseFixture()
  release.assets[0].state = 'new'
  assert.throws(() => parseRelease(release), /尚未上传完成/)
})

for (const digest of [
  undefined,
  null,
  '',
  'sha256:abc',
  `sha256:${'g'.repeat(64)}`,
  `sha512:${'a'.repeat(64)}`,
  `sha256:${'a'.repeat(65)}`,
  `sha256:${'a'.repeat(64)}\n`,
  123,
]) {
  test(`缺失或错误的SHA-256元数据被拒绝：${JSON.stringify(digest)}`, () => {
    const release = releaseFixture()
    assert.throws(
      () =>
        parseRelease({
          ...release,
          assets: [{ ...release.assets[0], digest }],
        }),
      /SHA-256/,
    )
  })
}

for (const size of [
  undefined,
  null,
  '4096',
  0,
  -1,
  1.5,
  NaN,
  Infinity,
  MAX_APK_BYTES + 1,
  Number.MAX_SAFE_INTEGER + 1,
]) {
  test(`安装包大小必须是上限内的正整数：${String(size)}`, () => {
    const release = releaseFixture()
    assert.throws(
      () =>
        parseRelease({
          ...release,
          assets: [{ ...release.assets[0], size }],
        }),
      /大小不受支持/,
    )
  })
}

test('安装包大小包含最小值及100MiB上限，更新说明限制长度并提供缺省值', () => {
  assert.equal(MAX_APK_BYTES, 100 * 1024 * 1024)
  const release = releaseFixture()
  for (const size of [1, MAX_APK_BYTES]) {
    assert.equal(parseRelease({ ...release, assets: [{ ...release.assets[0], size }] }).size, size)
  }
  assert.equal(parseRelease({ ...release, body: '新'.repeat(12001) }).notes, '新'.repeat(12000))
  assert.equal(parseRelease({ ...release, body: undefined }).notes, '此版本未提供更新说明。')
})

test('版本按主次修订整数顺序比较而不是字符串排序', () => {
  for (const [older, newer] of [
    ['0.1.9', '0.1.10'],
    ['0.9.99', '0.10.0'],
    ['1.99.99', '2.0.0'],
  ]) {
    assert.equal(compareVersions(older, newer), -1)
    assert.equal(compareVersions(newer, older), 1)
    assert.equal(compareVersions(newer, newer), 0)
  }
})

test('版本比较双方均拒绝预发布、前导零和非三段版本', () => {
  for (const version of [
    'v0.1.14',
    '0.1.14-beta',
    '0.01.14',
    '0.1',
    '0.1.14.0',
    '-1.0.0',
    '1000000.0.0',
  ]) {
    assert.throws(() => compareVersions(version, '0.1.14'), /版本号格式/)
    assert.throws(() => compareVersions('0.1.14', version), /版本号格式/)
  }
})

test('自动检查严格按当前原生版本24小时节流，手动检查越过节流', async () => {
  assert.equal(UPDATE_INTERVAL, 24 * 60 * 60 * 1000)
  const fixture = updaterFixture()
  await fixture.updater.check()
  const firstAttempt = { at: fixture.environment.now, version: '0.1.13' }
  assert.deepEqual(fixture.calls.savedAttempts, [firstAttempt])
  assert.equal(fixture.state.phase, 'available')
  fixture.environment.now += UPDATE_INTERVAL - 1
  await fixture.updater.check()
  assert.equal(fixture.calls.fetches, 1)
  assert.equal(fixture.calls.savedAttempts.length, 1)
  await fixture.updater.check(true)
  assert.equal(fixture.calls.fetches, 2)
  fixture.environment.now += UPDATE_INTERVAL - 1
  await fixture.updater.check()
  assert.equal(fixture.calls.fetches, 2)
  fixture.environment.now++
  await fixture.updater.check()
  assert.equal(fixture.calls.fetches, 3)
})

test('重建会话仍读取持久化节流，原生版本升级后不沿用旧版本节流', async () => {
  const fixture = updaterFixture()
  fixture.environment.lastAttempt = { at: fixture.environment.now, version: '0.1.13' }
  await fixture.updater.check()
  assert.equal(fixture.calls.fetches, 0)
  fixture.environment.version = '0.1.14'
  await fixture.updater.check()
  assert.equal(fixture.calls.fetches, 1)
  assert.equal(fixture.state.currentVersion, '0.1.14')
  assert.equal(fixture.state.phase, 'current')
  assert.deepEqual(fixture.environment.lastAttempt, {
    at: fixture.environment.now,
    version: '0.1.14',
  })
})

test('设备时钟回拨不会被未来的检查记录长期节流', async () => {
  const fixture = updaterFixture()
  fixture.environment.lastAttempt = { at: fixture.environment.now + 1000, version: '0.1.13' }
  await fixture.updater.check()
  assert.equal(fixture.calls.fetches, 1)
})

test('网络错误明确失败且保留尝试时间，自动节流但允许手动重试', async () => {
  const fixture = updaterFixture()
  fixture.dependencies.fetchRelease = async () => {
    fixture.calls.fetches++
    throw new Error('网络不可用')
  }
  await fixture.updater.check()
  assert.equal(fixture.state.phase, 'error')
  assert.equal(fixture.state.error, '网络不可用')
  assert.equal(fixture.state.release, undefined)
  assert.equal(fixture.calls.savedAttempts.length, 1)
  await fixture.updater.check()
  assert.equal(fixture.calls.fetches, 1)
  assert.equal(fixture.state.phase, 'error')
  fixture.dependencies.fetchRelease = async () => {
    fixture.calls.fetches++
    return releaseFixture()
  }
  await fixture.updater.check(true)
  assert.equal(fixture.calls.fetches, 2)
  assert.equal(fixture.state.phase, 'available')
  assert.equal(fixture.state.error, '')
})

test('已确认最新之后的网络失败也不能冒充最新', async () => {
  const fixture = updaterFixture()
  fixture.environment.version = '0.1.14'
  await fixture.updater.check(true)
  assert.equal(fixture.state.phase, 'current')
  fixture.dependencies.fetchRelease = async () => {
    throw new Error('GitHub超时')
  }
  await fixture.updater.check(true)
  assert.equal(fixture.state.phase, 'error')
  assert.equal(fixture.state.error, 'GitHub超时')
})

test('响应校验失败不会冒充最新，也不会开始下载', async () => {
  const fixture = updaterFixture({
    fetchRelease: async () => ({ ...releaseFixture(), prerelease: true }),
  })
  await fixture.updater.check(true)
  assert.equal(fixture.state.phase, 'error')
  assert.match(fixture.state.error, /正式版本/)
  assert.equal(fixture.calls.downloads.length, 0)
})

test('并发自动与手动检查共享同一在途请求，结束后可以重试', async () => {
  const response = deferred<unknown>()
  const fixture = updaterFixture()
  fixture.dependencies.fetchRelease = () => {
    fixture.calls.fetches++
    return response.promise
  }
  const automatic = fixture.updater.check()
  const manual = fixture.updater.check(true)
  assert.equal(automatic, manual)
  assert.equal(fixture.state.phase, 'checking')
  assert.equal(fixture.calls.fetches, 1)
  assert.equal(fixture.calls.savedAttempts.length, 1)
  await fixture.updater.download()
  await fixture.updater.install()
  assert.equal(fixture.calls.downloads.length, 0)
  response.resolve(releaseFixture())
  await Promise.all([automatic, manual])
  await fixture.updater.check(true)
  assert.equal(fixture.calls.fetches, 2)
})

test('不支持原生更新的平台自动检查静默退出，手动检查明确提示', async () => {
  const fixture = updaterFixture()
  fixture.environment.supported = false
  await fixture.updater.check()
  assert.equal(fixture.state.phase, 'idle')
  await fixture.updater.check(true)
  assert.equal(fixture.state.phase, 'error')
  assert.match(fixture.state.error, /仅支持安卓安装版/)
  assert.equal(fixture.calls.fetches, 0)
  assert.equal(fixture.calls.savedAttempts.length, 0)
})

test('检查和下载均不自动安装，只有用户分别触发才发生下载与安装', async () => {
  const fixture = updaterFixture()
  await fixture.updater.download()
  await fixture.updater.install()
  assert.equal(fixture.calls.downloads.length, 0)
  await fixture.updater.check()
  assert.equal(fixture.calls.downloads.length, 0)
  assert.equal(fixture.calls.installations.length, 0)
  await fixture.updater.install()
  assert.equal(fixture.calls.installations.length, 0)
  await fixture.updater.download()
  assert.equal(fixture.state.phase, 'ready')
  assert.equal(fixture.state.progress, 100)
  assert.equal(fixture.calls.downloads.length, 1)
  assert.equal(fixture.calls.verifications.length, 1)
  assert.equal(fixture.calls.installations.length, 0)
  assert.deepEqual(fixture.calls.downloads[0], fixture.state.release)
  await fixture.updater.install()
  assert.equal(fixture.calls.installations.length, 1)
  assert.equal(fixture.state.installerOpened, true)
  assert.equal(fixture.state.permissionNeeded, false)
  assert.equal(fixture.state.phase, 'ready')
})

test('下载单飞且期间不启动检查或安装，进度限定在0到100', async () => {
  const pending = deferred<string>()
  const fixture = updaterFixture()
  let reportProgress!: (bytes: number) => void
  fixture.dependencies.download = (release, progress) => {
    fixture.calls.downloads.push(release)
    reportProgress = progress
    return {
      promise: pending.promise,
      cancel: () => {
        fixture.calls.cancellations++
      },
    }
  }
  await fixture.updater.check(true)
  const downloading = fixture.updater.download()
  await fixture.updater.download()
  await fixture.updater.check(true)
  await fixture.updater.install()
  assert.equal(fixture.calls.downloads.length, 1)
  assert.equal(fixture.calls.fetches, 1)
  assert.equal(fixture.calls.installations.length, 0)
  reportProgress(-100)
  assert.equal(fixture.state.progress, 0)
  reportProgress(2048)
  assert.equal(fixture.state.progress, 50)
  reportProgress(8192)
  assert.equal(fixture.state.progress, 100)
  pending.resolve('/private/update/download.apk')
  await downloading
  await fixture.updater.download()
  assert.equal(fixture.calls.downloads.length, 1)
})

test('下载后的校验完成前不能安装或启动新检查与下载', async () => {
  const verification = deferred<void>()
  const started = deferred<void>()
  const fixture = updaterFixture({
    verify: () => {
      started.resolve()
      return verification.promise
    },
  })
  await fixture.updater.check(true)
  const downloading = fixture.updater.download()
  await started.promise
  assert.equal(fixture.state.phase, 'verifying')
  assert.equal(fixture.state.readyPath, '')
  await fixture.updater.install()
  await fixture.updater.check(true)
  await fixture.updater.download()
  assert.equal(fixture.calls.installations.length, 0)
  assert.equal(fixture.calls.fetches, 1)
  assert.equal(fixture.calls.downloads.length, 1)
  verification.resolve()
  await downloading
  assert.equal(fixture.state.phase, 'ready')
})

for (const failure of ['安装包SHA-256不匹配', '安装包实际大小不匹配']) {
  test(`${failure}时删除文件，不能进入可安装状态`, async () => {
    const fixture = updaterFixture({
      verify: async () => {
        throw new Error(failure)
      },
    })
    await fixture.updater.check(true)
    await fixture.updater.download()
    assert.equal(fixture.state.phase, 'error')
    assert.equal(fixture.state.error, failure)
    assert.equal(fixture.state.readyPath, '')
    assert.deepEqual(fixture.calls.removals, ['/private/update/stair-0.1.14-arm64.apk'])
    await fixture.updater.install()
    assert.equal(fixture.calls.installations.length, 0)
  })
}

test('取消立即释放下载，晚到的进度和完成只清理旧文件且不影响新下载', async () => {
  const cancelled = deferred<string>()
  const replacement = deferred<string>()
  const fixture = updaterFixture()
  let oldProgress!: (bytes: number) => void
  fixture.dependencies.download = (release, progress) => {
    fixture.calls.downloads.push(release)
    if (fixture.calls.downloads.length === 1) oldProgress = progress
    return {
      promise: fixture.calls.downloads.length === 1 ? cancelled.promise : replacement.promise,
      cancel: () => {
        fixture.calls.cancellations++
      },
    }
  }
  await fixture.updater.check(true)
  const firstDownload = fixture.updater.download()
  fixture.updater.cancel()
  fixture.updater.cancel()
  assert.equal(fixture.calls.cancellations, 1)
  assert.equal(fixture.state.phase, 'available')
  assert.equal(fixture.state.progress, 0)
  const secondDownload = fixture.updater.download()
  assert.equal(fixture.calls.downloads.length, 2)
  oldProgress(4096)
  assert.equal(fixture.state.progress, 0)
  cancelled.resolve('/private/update/cancelled.apk')
  await firstDownload
  assert.deepEqual(fixture.calls.removals, ['/private/update/cancelled.apk'])
  assert.equal(fixture.state.phase, 'downloading')
  assert.equal(fixture.state.readyPath, '')
  assert.equal(fixture.calls.verifications.length, 0)
  await fixture.updater.download()
  assert.equal(fixture.calls.downloads.length, 2)
  replacement.resolve('/private/update/replacement.apk')
  await secondDownload
  assert.equal(fixture.state.readyPath, '/private/update/replacement.apk')
  assert.equal(fixture.state.phase, 'ready')
  assert.equal(fixture.calls.installations.length, 0)
})

test('取消后晚到的失败不覆盖可重试状态，也不提示下载错误', async () => {
  const pending = deferred<string>()
  const fixture = updaterFixture({
    download: () => ({ promise: pending.promise, cancel: () => {} }),
  })
  await fixture.updater.check(true)
  const downloading = fixture.updater.download()
  fixture.updater.cancel()
  pending.reject(new Error('已取消的原生下载晚到失败'))
  await downloading
  assert.equal(fixture.state.phase, 'available')
  assert.equal(fixture.state.error, '')
  assert.equal(fixture.state.readyPath, '')
  assert.equal(fixture.calls.installations.length, 0)
})

test('成功下载后每次用户确认安装都先复验相同文件与发布信息', async () => {
  const fixture = updaterFixture()
  await fixture.updater.check(true)
  await fixture.updater.download()
  const readyPath = fixture.state.readyPath
  await fixture.updater.install()
  assert.deepEqual(fixture.calls.events, ['verify', 'verify', 'install'])
  assert.deepEqual(fixture.calls.verifications, [
    [readyPath, fixture.state.release],
    [readyPath, fixture.state.release],
  ])
  assert.deepEqual(fixture.calls.installations, [[readyPath, fixture.state.release]])
  assert.deepEqual(fixture.calls.removals, [])
})

test('安装前复验发现文件被替换时删除文件而不打开安装器', async () => {
  const fixture = updaterFixture()
  await fixture.updater.check(true)
  await fixture.updater.download()
  const readyPath = fixture.state.readyPath
  fixture.dependencies.verify = async () => {
    throw new Error('安装前SHA-256复验失败')
  }
  await fixture.updater.install()
  assert.equal(fixture.state.phase, 'error')
  assert.equal(fixture.state.error, '安装前SHA-256复验失败')
  assert.equal(fixture.state.readyPath, '')
  assert.deepEqual(fixture.calls.removals, [readyPath])
  assert.equal(fixture.calls.installations.length, 0)
})

for (const nativeVersion of ['0.1.14', '0.1.15', '0.2.0']) {
  test(`下载后原生版本已变为${nativeVersion}时拒绝安装旧包或同版本包`, async () => {
    const fixture = updaterFixture()
    await fixture.updater.check(true)
    await fixture.updater.download()
    const readyPath = fixture.state.readyPath
    fixture.environment.version = nativeVersion
    await fixture.updater.install()
    assert.equal(fixture.state.phase, 'error')
    assert.match(fixture.state.error, /当前版本已不低于安装包/)
    assert.equal(fixture.state.readyPath, '')
    assert.deepEqual(fixture.calls.removals, [readyPath])
    assert.equal(fixture.calls.verifications.length, 1)
    assert.equal(fixture.calls.installations.length, 0)
  })
}

test('发布版本不高于当前原生版本时标记当前已是最新', async () => {
  for (const nativeVersion of ['0.1.14', '0.1.15']) {
    const fixture = updaterFixture()
    fixture.environment.version = nativeVersion
    await fixture.updater.check(true)
    assert.equal(fixture.state.phase, 'current')
    assert.equal(fixture.state.currentVersion, nativeVersion)
    assert.equal(fixture.calls.downloads.length, 0)
    assert.equal(fixture.calls.installations.length, 0)
  }
})

test('安装来源授权返回permission后不自动重试，用户再次确认才复验并打开安装器', async () => {
  const fixture = updaterFixture()
  fixture.dependencies.install = async (path, release) => {
    fixture.calls.installations.push([path, release])
    return fixture.calls.installations.length === 1 ? 'permission' : 'opened'
  }
  await fixture.updater.check(true)
  await fixture.updater.download()
  await fixture.updater.install()
  await Promise.resolve()
  assert.equal(fixture.state.phase, 'ready')
  assert.equal(fixture.state.permissionNeeded, true)
  assert.equal(fixture.state.installerOpened, false)
  assert.equal(fixture.calls.installations.length, 1)
  assert.equal(fixture.calls.verifications.length, 2)
  await fixture.updater.download()
  assert.equal(fixture.calls.installations.length, 1)
  await fixture.updater.install()
  assert.equal(fixture.calls.installations.length, 2)
  assert.equal(fixture.calls.verifications.length, 3)
  assert.equal(fixture.state.permissionNeeded, false)
  assert.equal(fixture.state.installerOpened, true)
})

test('安装器已调起后晚到的原生失败清除成功提示，用户可明确重试', async () => {
  let reportFailure!: Parameters<UpdateDependencies['install']>[2]
  const fixture = updaterFixture()
  fixture.dependencies.install = async (path, release, failure) => {
    fixture.calls.installations.push([path, release])
    reportFailure = failure
    return 'opened'
  }
  await fixture.updater.check(true)
  await fixture.updater.download()
  const readyPath = fixture.state.readyPath
  await fixture.updater.install()
  assert.equal(fixture.state.installerOpened, true)
  reportFailure(new Error('系统无法打开安装包，请重新下载或检查安装权限'))
  assert.equal(fixture.state.installerOpened, false)
  assert.equal(fixture.state.error, '系统无法打开安装包，请重新下载或检查安装权限')
  assert.equal(fixture.state.readyPath, readyPath)
  assert.equal(fixture.state.phase, 'ready')
  assert.equal(fixture.calls.installations.length, 1)
  await fixture.updater.install()
  assert.equal(fixture.calls.installations.length, 2)
  assert.equal(fixture.calls.verifications.length, 3)
  assert.equal(fixture.state.error, '')
  assert.equal(fixture.state.installerOpened, true)
})

test('重新检查已清理旧安装包后，旧安装器晚到失败不能污染新检查状态', async () => {
  let reportFailure!: Parameters<UpdateDependencies['install']>[2]
  const fixture = updaterFixture({
    install: async (_path, _release, failure) => {
      reportFailure = failure
      return 'opened'
    },
  })
  await fixture.updater.check(true)
  await fixture.updater.download()
  await fixture.updater.install()
  await fixture.updater.check(true)
  reportFailure(new Error('旧安装器晚到失败'))
  assert.equal(fixture.state.phase, 'available')
  assert.equal(fixture.state.error, '')
  assert.equal(fixture.state.installerOpened, false)
  assert.equal(fixture.state.readyPath, '')
})

test('安装复验与系统安装器调用期间单飞，不能并发检查或下载', async () => {
  const verification = deferred<void>()
  const installation = deferred<'permission' | 'opened'>()
  const verifyStarted = deferred<void>()
  const installStarted = deferred<void>()
  const fixture = updaterFixture()
  await fixture.updater.check(true)
  await fixture.updater.download()
  fixture.dependencies.verify = () => {
    verifyStarted.resolve()
    return verification.promise
  }
  fixture.dependencies.install = (path, release) => {
    fixture.calls.installations.push([path, release])
    installStarted.resolve()
    return installation.promise
  }
  const installing = fixture.updater.install()
  await verifyStarted.promise
  await fixture.updater.install()
  await fixture.updater.check(true)
  await fixture.updater.download()
  assert.equal(fixture.calls.installations.length, 0)
  verification.resolve()
  await installStarted.promise
  await fixture.updater.install()
  await fixture.updater.check(true)
  await fixture.updater.download()
  assert.equal(fixture.calls.installations.length, 1)
  assert.equal(fixture.calls.fetches, 1)
  assert.equal(fixture.calls.downloads.length, 1)
  installation.resolve('opened')
  await installing
  assert.equal(fixture.state.installerOpened, true)
})

test('下载网络失败后用户可直接重试，不遗留在途锁或错误提示', async () => {
  const fixture = updaterFixture()
  const download = fixture.dependencies.download
  fixture.dependencies.download = () => ({
    promise: Promise.reject(new Error('安装包下载中断')),
    cancel: () => {},
  })
  await fixture.updater.check(true)
  await fixture.updater.download()
  assert.equal(fixture.state.phase, 'error')
  assert.equal(fixture.state.error, '安装包下载中断')
  assert.equal(fixture.state.readyPath, '')
  assert.deepEqual(fixture.calls.removals, [])
  fixture.dependencies.download = download
  await fixture.updater.download()
  assert.equal(fixture.state.phase, 'ready')
  assert.equal(fixture.state.error, '')
  assert.equal(fixture.calls.installations.length, 0)
})

test('完整性校验失败后用户重新下载可恢复，不能复用被删除文件', async () => {
  const fixture = updaterFixture()
  const verify = fixture.dependencies.verify
  fixture.dependencies.verify = async () => {
    throw new Error('坏包')
  }
  await fixture.updater.check(true)
  await fixture.updater.download()
  fixture.dependencies.verify = verify
  await fixture.updater.download()
  assert.equal(fixture.calls.downloads.length, 2)
  assert.equal(fixture.calls.removals.length, 1)
  assert.equal(fixture.state.phase, 'ready')
  assert.equal(fixture.state.error, '')
  await fixture.updater.install()
  assert.equal(fixture.calls.installations.length, 1)
})

test('安装器调用失败保留已校验文件，用户可直接再次确认安装', async () => {
  const fixture = updaterFixture()
  const install = fixture.dependencies.install
  fixture.dependencies.install = async () => {
    throw new Error('系统安装器不可用')
  }
  await fixture.updater.check(true)
  await fixture.updater.download()
  const readyPath = fixture.state.readyPath
  await fixture.updater.install()
  assert.equal(fixture.state.phase, 'ready')
  assert.equal(fixture.state.error, '系统安装器不可用')
  assert.equal(fixture.state.readyPath, readyPath)
  assert.equal(fixture.state.installerOpened, false)
  assert.deepEqual(fixture.calls.removals, [])
  fixture.dependencies.install = install
  await fixture.updater.install()
  assert.equal(fixture.state.error, '')
  assert.equal(fixture.state.installerOpened, true)
  assert.equal(fixture.state.phase, 'ready')
  assert.equal(fixture.state.readyPath, readyPath)
  assert.equal(fixture.calls.downloads.length, 1)
  assert.equal(fixture.calls.verifications.length, 3)
  assert.deepEqual(fixture.calls.removals, [])
  assert.equal(fixture.calls.installations.length, 1)
})

test('重新手动检查清理旧安装包及授权展示状态，不会沿用旧确认结果', async () => {
  const fixture = updaterFixture({ install: async () => 'permission' })
  await fixture.updater.check(true)
  await fixture.updater.download()
  await fixture.updater.install()
  const readyPath = fixture.state.readyPath
  fixture.state.dismissed = true
  fixture.state.installerOpened = true
  await fixture.updater.check(true)
  assert.deepEqual(fixture.calls.removals, [readyPath])
  assert.equal(fixture.state.readyPath, '')
  assert.equal(fixture.state.permissionNeeded, false)
  assert.equal(fixture.state.installerOpened, false)
  assert.equal(fixture.state.dismissed, false)
  assert.equal(fixture.state.phase, 'available')
})
