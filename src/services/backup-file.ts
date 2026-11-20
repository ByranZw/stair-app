import { MAX_BACKUP_BYTES, assertBackupSize } from '../domain/backup'

/** 返回已读取的本地文件；取消选择以undefined返回，不冒充文件损坏。 */
export interface BackupFile {
  name: string
  text: string
}
/** 默认名称带时间，系统另存为同名文件时也不会覆盖原备份。 */
export function backupFilename(): string {
  return `拾阶-stair-${new Date().toISOString().replace(/[:.]/g, '-')}.json`
}

// #ifdef H5
/** 浏览器File边界先校验字节上限，再按UTF-8读取；不上传到任何网络接口。 */
async function readBrowserFile(file: File): Promise<BackupFile> {
  if (file.size > MAX_BACKUP_BYTES) throw new Error('备份文件超过10MB')
  return { name: file.name, text: await file.text() }
}
// #endif

// #ifdef APP-PLUS
/** Native.js桥只在本模块使用，声明真实可变参数签名弥补官方类型声明的缺口。 */
function invoke<T>(
  object: PlusAndroidInstanceObject | string,
  method: string,
  ...args: unknown[]
): T {
  return (
    plus.android.invoke as unknown as (
      target: PlusAndroidInstanceObject | string,
      name: string,
      ...values: unknown[]
    ) => T
  )(object, method, ...args)
}
/** 原生流构造限定为固定系统类，不接受来自备份内容的类名或代码。 */
function construct(name: string, ...args: unknown[]): PlusAndroidInstanceObject {
  return (
    plus.android.newObject as unknown as (
      name: string,
      ...values: unknown[]
    ) => PlusAndroidInstanceObject
  )(name, ...args)
}
/** 活动回调只拦截本模块请求，其他原生功能的回调原样转交并在结束后恢复。 */
interface DocumentActivity extends PlusAndroidInstanceObject {
  onActivityResult?: (
    request: number,
    result: number,
    data: PlusAndroidInstanceObject | null,
  ) => void
}
let selecting = false
/** 安卓SAF让用户选择具体文件，无需全盘读写权限；取消时不读取或写入。 */
async function chooseDocument(
  write: boolean,
  name?: string,
): Promise<PlusAndroidInstanceObject | undefined> {
  if (plus.os.name !== 'Android') throw new Error('文件备份目前支持浏览器和安卓')
  if (selecting) throw new Error('已有文件选择窗口，请先完成或取消')
  selecting = true
  const activity = plus.android.runtimeMainActivity() as DocumentActivity
  const previous = activity.onActivityResult,
    requestCode = 22407
  try {
    const intent = construct(
      'android.content.Intent',
      write ? 'android.intent.action.CREATE_DOCUMENT' : 'android.intent.action.OPEN_DOCUMENT',
    )
    invoke(intent, 'addCategory', 'android.intent.category.OPENABLE')
    invoke(intent, 'setType', write ? 'application/json' : '*/*')
    if (name) invoke(intent, 'putExtra', 'android.intent.extra.TITLE', name)
    return await new Promise((resolve, reject) => {
      activity.onActivityResult = (request, result, data) => {
        if (request !== requestCode) {
          previous?.call(activity, request, result, data)
          return
        }
        activity.onActivityResult = previous
        if (result !== -1 || !data) {
          resolve(undefined)
          return
        }
        try {
          const uri = invoke<PlusAndroidInstanceObject | null>(data, 'getData')
          if (!uri) throw new Error('未取得文件位置')
          resolve(uri)
        } catch {
          reject(new Error('系统未能读取所选文件位置'))
        }
      }
      try {
        invoke(activity, 'startActivityForResult', intent, requestCode)
      } catch {
        activity.onActivityResult = previous
        reject(new Error('无法打开系统文件选择器'))
      }
    })
  } finally {
    selecting = false
  }
}
/** 原生UTF-8输入流按4096字符分块有限读取，所有退出路径释放流；最终仍校验实际UTF-8字节数。 */
function readAndroidFile(uri: PlusAndroidInstanceObject): string {
  const resolver = invoke<PlusAndroidInstanceObject>(
    plus.android.runtimeMainActivity(),
    'getContentResolver',
  )
  const stream = invoke<PlusAndroidInstanceObject | null>(resolver, 'openInputStream', uri)
  if (!stream) throw new Error('备份文件无法打开')
  let reader: PlusAndroidInstanceObject | undefined
  try {
    reader = construct(
      'java.io.BufferedReader',
      construct('java.io.InputStreamReader', stream, 'UTF-8'),
    )
    const chunks: string[] = []
    let length = 0
    const buffer = invoke<PlusAndroidInstanceObject>('java.nio.CharBuffer', 'allocate', 4096)
    while (length <= MAX_BACKUP_BYTES) {
      const count = invoke<number>(reader, 'read', buffer)
      if (count === -1) {
        const text = chunks.join('')
        assertBackupSize(text)
        return text
      }
      if (count === 0) throw new Error('备份文件读取未能继续，请重新选择')
      length += count
      invoke(buffer, 'flip')
      chunks.push(String(invoke<string>(buffer, 'toString')))
      invoke(buffer, 'clear')
    }
    throw new Error('备份文件超过10MB')
  } finally {
    invoke(reader || stream, 'close')
  }
}
/** 原生保存到用户指定的文档位置；flush和close成功后才报告已导出。 */
function writeAndroidFile(uri: PlusAndroidInstanceObject, text: string): void {
  const resolver = invoke<PlusAndroidInstanceObject>(
    plus.android.runtimeMainActivity(),
    'getContentResolver',
  )
  const stream = invoke<PlusAndroidInstanceObject | null>(resolver, 'openOutputStream', uri, 'wt')
  if (!stream) throw new Error('无法写入所选位置')
  let writer: PlusAndroidInstanceObject | undefined
  try {
    writer = construct('java.io.OutputStreamWriter', stream, 'UTF-8')
    invoke(writer, 'write', text)
    invoke(writer, 'flush')
  } finally {
    invoke(writer || stream, 'close')
  }
}
/** 把原生选择与写入封装在可达分支，双端条件编译和TS均能正确收窄取消结果。 */
async function saveAndroidBackup(text: string, name: string): Promise<'saved' | 'cancelled'> {
  const uri = await chooseDocument(true, name)
  if (!uri) return 'cancelled'
  writeAndroidFile(uri, text)
  return 'saved'
}
/** 安卓选择只返回已读取内容，不把URI当成可长期保存的用户授权。 */
async function chooseAndroidBackup(): Promise<BackupFile | undefined> {
  const uri = await chooseDocument(false)
  return uri ? { name: '所选账本备份.json', text: readAndroidFile(uri) } : undefined
}
// #endif

/** 由用户点击触发下载/另存为，返回取消状态，页面不能把下载请求当文件已落盘。 */
export async function saveBackupFile(text: string): Promise<'download' | 'saved' | 'cancelled'> {
  assertBackupSize(text)
  const name = backupFilename()
  // #ifdef H5
  const url = URL.createObjectURL(new Blob([text], { type: 'application/json;charset=utf-8' }))
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = name
  document.body.appendChild(anchor)
  try {
    anchor.click()
  } finally {
    anchor.remove()
    setTimeout(() => URL.revokeObjectURL(url), 30000)
  }
  return 'download'
  // #endif
  // #ifdef APP-PLUS
  return saveAndroidBackup(text, name)
  // #endif
}
/** 打开本机选择器；只把所选文件交给领域预检，不修改账本。 */
export async function chooseBackupFile(): Promise<BackupFile | undefined> {
  // #ifdef H5
  return new Promise((resolve, reject) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.json,application/json'
    input.hidden = true
    document.body.appendChild(input)
    input.oncancel = () => {
      input.remove()
      resolve(undefined)
    }
    input.onchange = async () => {
      try {
        const file = input.files?.[0]
        resolve(file ? await readBrowserFile(file) : undefined)
      } catch (error) {
        reject(error)
      } finally {
        input.remove()
      }
    }
    input.click()
  })
  // #endif
  // #ifdef APP-PLUS
  return chooseAndroidBackup()
  // #endif
}
