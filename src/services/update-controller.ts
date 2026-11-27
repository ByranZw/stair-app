import {
  compareVersions,
  parseRelease,
  UPDATE_INTERVAL,
  type AppRelease,
} from '../domain/app-update'

/** 更新状态与账本分离，安装器已打开不代表用户已完成安装。 */
export interface UpdateState {
  phase:
    | 'idle'
    | 'checking'
    | 'current'
    | 'available'
    | 'downloading'
    | 'verifying'
    | 'ready'
    | 'error'
  currentVersion: string
  release?: AppRelease
  error: string
  progress: number
  readyPath: string
  permissionNeeded: boolean
  installerOpened: boolean
  dismissed: boolean
}

/** 平台边界供原生实现与离线流程测试复用，不向账本暴露更新状态。 */
export interface UpdateDependencies {
  supported(): boolean
  version(): string
  now(): number
  lastAttempt(): { at: number; version: string } | undefined
  saveAttempt(value: { at: number; version: string }): void
  fetchRelease(): Promise<unknown>
  download(
    release: AppRelease,
    progress: (bytes: number) => void,
  ): {
    promise: Promise<string>
    cancel(): void
  }
  verify(path: string, release: AppRelease): Promise<void>
  remove(path: string): void
  install(
    path: string,
    release: AppRelease,
    failure: (error: Error) => void,
  ): Promise<'permission' | 'opened'>
}

/** 创建独立更新会话；检查单飞、下载单飞，失败不回写成已是最新。 */
export function createUpdater(deps: UpdateDependencies, state: UpdateState) {
  let checkTask: Promise<void> | undefined
  let downloadTask: ReturnType<UpdateDependencies['download']> | undefined
  let generation = 0
  let installing = false
  return {
    state,
    /** 自动检查每24小时最多尝试一次；手动检查允许立即重试网络失败。 */
    check(manual = false): Promise<void> {
      if (checkTask) return checkTask
      if (downloadTask || state.phase === 'verifying' || installing) return Promise.resolve()
      if (!deps.supported()) {
        if (manual) {
          state.phase = 'error'
          state.error = 'App内更新仅支持安卓安装版'
        }
        return Promise.resolve()
      }
      checkTask = (async () => {
        try {
          const current = deps.version()
          const now = deps.now()
          const last = deps.lastAttempt()
          if (
            !manual &&
            last?.version === current &&
            last.at <= now &&
            now - last.at < UPDATE_INTERVAL
          )
            return
          deps.saveAttempt({ at: now, version: current })
          if (state.readyPath) deps.remove(state.readyPath)
          state.readyPath = ''
          state.permissionNeeded = false
          state.installerOpened = false
          state.error = ''
          state.currentVersion = current
          state.phase = 'checking'
          const release = parseRelease(await deps.fetchRelease())
          state.release = release
          state.phase = compareVersions(release.version, current) > 0 ? 'available' : 'current'
          state.dismissed = false
        } catch (error) {
          state.phase = 'error'
          state.error = error instanceof Error ? error.message : '检查更新失败，请稍后重试'
        }
      })().finally(() => {
        checkTask = undefined
      })
      return checkTask
    },
    /** 只有用户触发才下载；取消或错误文件不进入已校验状态。 */
    async download(): Promise<void> {
      if (
        !state.release ||
        checkTask ||
        downloadTask ||
        state.phase === 'verifying' ||
        installing ||
        state.readyPath
      )
        return
      const release = state.release
      const attempt = ++generation
      let path = ''
      state.error = ''
      state.progress = 0
      state.phase = 'downloading'
      try {
        downloadTask = deps.download(release, (bytes) => {
          if (attempt === generation)
            state.progress = Math.min(100, Math.max(0, Math.floor((bytes / release.size) * 100)))
        })
        path = await downloadTask.promise
        if (attempt !== generation) {
          deps.remove(path)
          return
        }
        state.phase = 'verifying'
        await deps.verify(path, release)
        if (attempt !== generation) {
          deps.remove(path)
          return
        }
        state.readyPath = path
        state.phase = 'ready'
        state.progress = 100
      } catch (error) {
        if (path) deps.remove(path)
        if (attempt === generation) {
          state.phase = 'error'
          state.error = error instanceof Error ? error.message : '下载失败，请重试'
        }
      } finally {
        if (attempt === generation) downloadTask = undefined
      }
    },
    /** 取消立即释放会话，晚到的完成回调只负责清理，不再提示或安装。 */
    cancel(): void {
      if (!downloadTask || state.phase !== 'downloading') return
      generation++
      downloadTask.cancel()
      downloadTask = undefined
      state.phase = 'available'
      state.progress = 0
    },
    /** 再次确认后复验文件及原生版本；设置授权返回不会自动安装。 */
    async install(): Promise<void> {
      if (installing || state.phase !== 'ready' || !state.readyPath || !state.release) return
      installing = true
      state.error = ''
      let verified = false
      try {
        if (compareVersions(state.release.version, deps.version()) <= 0)
          throw new Error('当前版本已不低于安装包，请重新检查更新')
        await deps.verify(state.readyPath, state.release)
        verified = true
        const installPath = state.readyPath
        const result = await deps.install(installPath, state.release, (error) => {
          if (state.readyPath !== installPath) return
          state.error = error.message
          state.installerOpened = false
        })
        state.permissionNeeded = result === 'permission'
        state.installerOpened = result === 'opened'
      } catch (error) {
        state.error = error instanceof Error ? error.message : '无法打开系统安装器，请重试'
        state.installerOpened = false
        if (!verified) {
          if (state.readyPath) deps.remove(state.readyPath)
          state.readyPath = ''
          state.phase = 'error'
        }
      } finally {
        installing = false
      }
    },
  }
}
