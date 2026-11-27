/** 更新只信任本项目正式发布，不接受服务端下发的任意下载地址。 */
export const RELEASE_API = 'https://api.github.com/repos/ByranZw/stair-app/releases/latest'
export const RELEASE_HOME = 'https://github.com/ByranZw/stair-app/releases'
export const RELEASE_MANIFEST = `${RELEASE_HOME}/latest/download/update.json`
export const UPDATE_INTERVAL = 24 * 60 * 60 * 1000
export const MAX_APK_BYTES = 100 * 1024 * 1024

/** 经来源、版本及完整性元数据校验的ARM64正式发布。 */
export interface AppRelease {
  version: string
  notes: string
  url: string
  assetUrl: string
  size: number
  sha256: string
}

/** 正式版本按三个整数比较，避免把0.1.10排在0.1.9之前。 */
export function compareVersions(left: string, right: string): number {
  const pattern = /^(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})\.(0|[1-9]\d{0,5})$/
  if (!pattern.test(left) || !pattern.test(right)) throw new Error('版本号格式不受支持')
  const leftParts = left.split('.').map(Number)
  const rightParts = right.split('.').map(Number)
  for (let index = 0; index < 3; index++) {
    if (leftParts[index] !== rightParts[index])
      return Math.sign(leftParts[index] - rightParts[index])
  }
  return 0
}

/** GitHub响应在边界解析；缺摘要、跨仓库或预发布都不能进入下载阶段。 */
export function parseRelease(input: unknown): AppRelease {
  const release = input as Record<string, unknown> | null
  if (!release || release.draft !== false || release.prerelease !== false)
    throw new Error('GitHub未返回可用的正式版本')
  const tag = String(release.tag_name || '')
  const version = tag.startsWith('v') ? tag.slice(1) : ''
  compareVersions(version, version)
  const url = `${RELEASE_HOME}/tag/${tag}`
  if (release.html_url !== url || !Array.isArray(release.assets))
    throw new Error('版本来源或安装包信息不正确')
  const name = `stair-${version}-arm64.apk`
  const assets = release.assets.filter((asset) => asset && asset.name === name)
  if (assets.length !== 1) throw new Error('该版本缺少唯一的ARM64安装包')
  const asset = assets[0]
  const assetUrl = `${RELEASE_HOME}/download/${tag}/${name}`
  if (asset.browser_download_url !== assetUrl || asset.state !== 'uploaded')
    throw new Error('安装包下载来源不正确或尚未上传完成')
  if (!Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > MAX_APK_BYTES)
    throw new Error('安装包大小不受支持')
  if (typeof asset.digest !== 'string' || !/^sha256:[a-fA-F0-9]{64}$/.test(asset.digest))
    throw new Error('安装包缺少SHA-256校验信息，暂不能更新')
  return {
    version,
    url,
    assetUrl,
    size: asset.size,
    sha256: asset.digest.slice(7).toLowerCase(),
    notes:
      typeof release.body === 'string' ? release.body.slice(0, 12000) : '此版本未提供更新说明。',
  }
}
