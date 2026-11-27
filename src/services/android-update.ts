import { compareVersions, type AppRelease } from '../domain/app-update'

/** 原生桥的可变参数签名与项目既有SAF实现保持一致。 */
function invoke<T>(
  target: PlusAndroidInstanceObject | string,
  name: string,
  ...args: unknown[]
): T {
  return (
    plus.android.invoke as unknown as (
      object: PlusAndroidInstanceObject | string,
      method: string,
      ...values: unknown[]
    ) => T
  )(target, name, ...args)
}

/** 只构造固定安卓/Java系统类，不使用Release内容作为类名。 */
function construct(name: string, ...args: unknown[]): PlusAndroidInstanceObject {
  return (
    plus.android.newObject as unknown as (
      className: string,
      ...values: unknown[]
    ) => PlusAndroidInstanceObject
  )(name, ...args)
}

/** H5构建不包含原生调用，运行时也不把普通浏览器识别成安卓安装版。 */
export function androidUpdateSupported(): boolean {
  // #ifdef APP-PLUS
  return typeof plus !== 'undefined' && plus.os.name === 'Android'
  // #endif
  // #ifndef APP-PLUS
  return false
  // #endif
}

/** 读取真正安装的APK版本，不依赖页面展示文字或热更新资源版本。 */
export function installedVersion(): string {
  const version = plus.runtime.version
  if (!version) throw new Error('无法读取当前安装版本，请重新启动应用')
  return version
}

/** 只移除本功能生成的私有更新文件，不访问账本或用户选择的备份。 */
export function removeUpdate(path: string): void {
  if (!path.startsWith('_doc/updates/')) return
  plus.io.resolveLocalFileSystemURL(
    path,
    (entry) => entry.remove(() => undefined),
    () => undefined,
  )
}

/** 下次下载前清理上次中断或旧版残留，下载目录只属于更新功能。 */
function clearUpdates(): Promise<void> {
  return new Promise((resolve, reject) => {
    plus.io.resolveLocalFileSystemURL(
      '_doc/updates/',
      (entry) => {
        ;(entry as PlusIoDirectoryEntry).removeRecursively(
          () => resolve(),
          () => reject(new Error('无法清理旧安装包，请重试')),
        )
      },
      () => resolve(),
    )
  })
}

/** 下载到应用私有目录；总超时、超额响应和取消都清理本次文件。 */
export function downloadUpdate(release: AppRelease, progress: (bytes: number) => void) {
  let task: PlusDownloaderDownload | undefined
  let cancelled = false
  let rejectDownload: ((error: Error) => void) | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const filename = `_doc/updates/stair-${release.version}-${Date.now()}.apk`
  /** 停止原生请求并释放本次的临时文件及等待者。 */
  function stop(message: string): void {
    cancelled = true
    if (timer) clearTimeout(timer)
    task?.abort()
    removeUpdate(plus.io.convertAbsoluteFileSystem(task?.filename || filename))
    rejectDownload?.(new Error(message))
  }
  const promise = new Promise<string>((resolve, reject) => {
    rejectDownload = reject
    void clearUpdates()
      .then(() => {
        if (cancelled) return
        task = plus.downloader.createDownload(
          release.assetUrl,
          {
            filename,
            timeout: 45,
            retry: 0,
          },
          (download, status) => {
            if (timer) clearTimeout(timer)
            const savedPath = plus.io.convertAbsoluteFileSystem(download.filename || filename)
            if (cancelled) {
              removeUpdate(savedPath)
              return
            }
            if (status !== 200) {
              stop(`安装包下载失败（HTTP ${status}），请重试`)
              return
            }
            if (!savedPath.startsWith('_doc/updates/')) {
              stop('安装包保存位置不正确')
              return
            }
            resolve(savedPath)
          },
        )
        task.addEventListener('statechanged', (download) => {
          if (cancelled) return
          const bytes = download.downloadedSize || 0
          if (bytes > release.size) {
            stop('安装包超过声明大小，已停止下载')
            return
          }
          progress(bytes)
        })
        timer = setTimeout(() => stop('下载超过10分钟，请检查网络后重试'), 10 * 60 * 1000)
        task.start()
      })
      .catch((error) => stop(error instanceof Error ? error.message : '无法开始下载，请重试'))
  })
  return { promise, cancel: () => stop('已取消下载') }
}

/** 文件通道每次只读64KiB，分批让出UI线程，不把APK转成大块JS/Base64内存。 */
export async function verifyUpdate(path: string, release: AppRelease): Promise<void> {
  if (!path.startsWith('_doc/updates/')) throw new Error('安装包位置不正确')
  const localPath = plus.io.convertLocalFileSystemURL(path)
  const file = construct('java.io.File', localPath)
  if (invoke<number>(file, 'length') !== release.size)
    throw new Error('安装包大小不匹配，请重新下载')
  const stream = construct('java.io.FileInputStream', file)
  let bytes = 0
  try {
    const channel = invoke<PlusAndroidInstanceObject>(stream, 'getChannel')
    const digest = invoke<PlusAndroidInstanceObject>(
      'java.security.MessageDigest',
      'getInstance',
      'SHA-256',
    )
    const buffer = invoke<PlusAndroidInstanceObject>('java.nio.ByteBuffer', 'allocate', 65536)
    while (bytes < release.size) {
      const count = invoke<number>(channel, 'read', buffer)
      if (count <= 0) throw new Error('安装包读取中断，请重新下载')
      bytes += count
      if (bytes > release.size) throw new Error('安装包大小不匹配，请重新下载')
      invoke(buffer, 'flip')
      invoke(digest, 'update', buffer)
      invoke(buffer, 'clear')
      if (bytes % (65536 * 8) === 0) await new Promise((resolve) => setTimeout(resolve, 0))
    }
    const hash = String(
      invoke(construct('java.math.BigInteger', 1, invoke(digest, 'digest')), 'toString', 16),
    ).padStart(64, '0')
    if (hash !== release.sha256 || invoke<number>(file, 'length') !== release.size)
      throw new Error('安装包SHA-256校验失败，已禁止安装，请重新下载')
  } finally {
    invoke(stream, 'close')
  }
  const activity = plus.android.runtimeMainActivity()
  const manager = invoke<PlusAndroidInstanceObject>(activity, 'getPackageManager')
  const info = invoke<PlusAndroidInstanceObject | null>(
    manager,
    'getPackageArchiveInfo',
    localPath,
    0,
  )
  if (
    !info ||
    plus.android.getAttribute(info, 'packageName') !== 'cn.stair.invest' ||
    plus.android.getAttribute(info, 'versionName') !== release.version
  )
    throw new Error('安装包应用或版本不匹配，请重新检查更新')
  const current = invoke<PlusAndroidInstanceObject>(manager, 'getPackageInfo', 'cn.stair.invest', 0)
  const nextCode = Number(plus.android.getAttribute(info, 'versionCode'))
  const currentCode = Number(plus.android.getAttribute(current, 'versionCode'))
  if (
    !Number.isSafeInteger(nextCode) ||
    !Number.isSafeInteger(currentCode) ||
    nextCode <= currentCode ||
    compareVersions(release.version, installedVersion()) <= 0
  )
    throw new Error('不能安装相同或更低版本，请重新检查更新')
}

/** 安卓8+先引导当前应用的安装来源授权；只调起系统安装器，不承诺安装完成。 */
export async function installUpdate(path: string): Promise<'permission' | 'opened'> {
  const activity = plus.android.runtimeMainActivity()
  const manager = invoke<PlusAndroidInstanceObject>(activity, 'getPackageManager')
  const versionClass = plus.android.importClass('android.os.Build$VERSION') as unknown as {
    SDK_INT: number
  }
  const sdk = Number(versionClass.SDK_INT)
  if (!Number.isInteger(sdk) || sdk < 21) throw new Error('无法确认安卓系统版本，请重新启动应用')
  if (sdk >= 26 && !invoke<boolean>(manager, 'canRequestPackageInstalls')) {
    const intent = construct(
      'android.content.Intent',
      'android.settings.MANAGE_UNKNOWN_APP_SOURCES',
    )
    const uri = invoke<PlusAndroidInstanceObject>(
      'android.net.Uri',
      'parse',
      'package:cn.stair.invest',
    )
    invoke(intent, 'setData', uri)
    invoke(activity, 'startActivity', intent)
    return 'permission'
  }
  const file = construct('java.io.File', plus.io.convertLocalFileSystemURL(path))
  const uri = invoke<PlusAndroidInstanceObject>(
    'androidx.core.content.FileProvider',
    'getUriForFile',
    activity,
    'cn.stair.invest.dc.fileprovider',
    file,
  )
  const intent = construct('android.content.Intent', 'android.intent.action.VIEW')
  invoke(intent, 'setDataAndType', uri, 'application/vnd.android.package-archive')
  invoke(intent, 'addFlags', 1)
  invoke(activity, 'startActivity', intent)
  return 'opened'
}
