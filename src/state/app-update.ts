import { reactive } from 'vue'
import manifest from '../manifest.json'
import { RELEASE_API, RELEASE_MANIFEST } from '../domain/app-update'
import { createUpdater, type UpdateState } from '../services/update-controller'
import {
  androidUpdateSupported,
  installedVersion,
  downloadUpdate,
  verifyUpdate,
  removeUpdate,
  installUpdate,
} from '../services/android-update'

/** 更新只保存检查时间和原生版本，使用独立键，不读写投资数据。 */
const ATTEMPT_KEY = 'stair-update-attempt-v1'
export const appUpdateState = reactive<UpdateState>({
  phase: 'idle',
  currentVersion: manifest.versionName,
  error: '',
  progress: 0,
  readyPath: '',
  permissionNeeded: false,
  installerOpened: false,
  dismissed: false,
})

/** 优先读取Release更新清单避免公共API额度；只有旧版缺清单时回退一次API。 */
export function fetchLatestRelease(url = RELEASE_MANIFEST): Promise<unknown> {
  return new Promise((resolve, reject) => {
    uni.request({
      url,
      timeout: 15000,
      dataType: 'json',
      header: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
      success: (response) => {
        if (response.statusCode === 200) resolve(response.data)
        else if (response.statusCode === 404 && url === RELEASE_MANIFEST)
          resolve(fetchLatestRelease(RELEASE_API))
        else
          reject(
            new Error(
              response.statusCode === 403 || response.statusCode === 429
                ? 'GitHub暂时限流，请稍后重试'
                : `检查更新失败（HTTP ${response.statusCode}），请稍后重试`,
            ),
          )
      },
      fail: () => reject(new Error('暂时无法连接GitHub，请检查网络后重试；不影响记账')),
    })
  })
}

export const appUpdater = createUpdater(
  {
    supported: androidUpdateSupported,
    version: installedVersion,
    now: Date.now,
    lastAttempt: () => {
      try {
        const value = uni.getStorageSync(ATTEMPT_KEY)
        return value &&
          Number.isFinite(value.at) &&
          value.at > 0 &&
          typeof value.version === 'string'
          ? value
          : undefined
      } catch {
        return undefined
      }
    },
    saveAttempt: (value) => {
      uni.setStorageSync(ATTEMPT_KEY, value)
    },
    fetchRelease: fetchLatestRelease,
    download: downloadUpdate,
    verify: verifyUpdate,
    remove: removeUpdate,
    install: installUpdate,
  },
  appUpdateState,
)
