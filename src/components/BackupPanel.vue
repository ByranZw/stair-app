<script setup lang="ts">
import { formatDateTime } from '../domain/display-time'
import { computed, ref, onBeforeUnmount } from 'vue'
import type { Backup } from '../domain/backup'
import { readBackup } from '../domain/backup'
import { projectBook } from '../domain/ledger'
import { D, formatMoney } from '../domain/money'
import { bookState, exportBook, restoreBook, readRecoveryBackup } from '../state/book'
import { chooseBackupFile, saveBackupFile } from '../services/backup-file'
import { showToast } from '../state/feedback'
import { saveFormDraft, readFormDraft, clearFormDraft } from '../state/form-drafts'
const busy = ref(false),
  error = ref(''),
  message = ref(''),
  preview = ref<Backup>(),
  source = ref(''),
  originalText = ref(''),
  expectedRevision = ref(0)
const recovery = ref<Awaited<ReturnType<typeof readRecoveryBackup>>>()
const summary = computed(() => {
  if (!preview.value) return undefined
  const book = preview.value.book,
    derived = projectBook(book)
  return {
    accounts: book.accounts.length,
    trades: book.trades.length,
    plans: book.plans.length,
    positions: Object.values(derived.positions).filter((p) => new D(p.qty).gt(0)).length,
    cash: Object.values(derived.cash)
      .reduce((sum, value) => sum.plus(value), new D(0))
      .toString(),
  }
})
const changed = computed(() => preview.value && bookState.data.revision !== expectedRevision.value)
/** 最近恢复副本来自事务数据库；读取失败直接告知，不能把损坏误报成没有副本。 */
async function loadRecovery(): Promise<void> {
  try {
    recovery.value = await readRecoveryBackup()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '上次操作前副本读取失败'
  }
}
/** 同一文件允许重新预检；版本更新时先刷新对比范围，再让用户重新确认。 */
function inspect(text: string, name: string): void {
  const data = readBackup(text)
  preview.value = data
  source.value = name
  originalText.value = text
  expectedRevision.value = bookState.data.revision
  error.value = ''
  message.value = ''
}
/** 导出只读取已提交版本，下载行为的结果按平台实际能力描述。 */
async function download(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  try {
    const result = await saveBackupFile(await exportBook())
    if (result !== 'cancelled') {
      message.value =
        result === 'download'
          ? '已发起下载，请在浏览器下载列表确认保存。'
          : '备份文件已保存到所选位置。'
      showToast(result === 'download' ? '备份已发起下载' : '备份已保存')
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : '备份导出失败'
  } finally {
    busy.value = false
  }
}
/** 选文件后只做内存预检，用户确认前不写入任何账户数据。 */
async function selectFile(): Promise<void> {
  if (busy.value) return
  busy.value = true
  error.value = ''
  message.value = ''
  preview.value = undefined
  originalText.value = ''
  try {
    const file = await chooseBackupFile()
    if (file) inspect(file.text, file.name)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '无法读取备份文件'
  } finally {
    busy.value = false
  }
}
/** 上次操作前副本同样展示预检，不以点击回退按钮直接覆盖当前资金。 */
function previewRecovery(): void {
  if (recovery.value) inspect(recovery.value.text, '最近一次操作前账本')
}
/** 预检期间发生记账/行情状态更新时，旧预检失效，保留文件便于重新核对。 */
function reinspect(): void {
  try {
    inspect(originalText.value, source.value)
  } catch (e) {
    error.value = e instanceof Error ? e.message : '预检失败'
  }
}
/** 明确确认后一次事务恢复；失败保留预检与当前数据，成功后展示新副本入口。 */
async function confirmRestore(): Promise<void> {
  if (busy.value || !preview.value || changed.value) return
  busy.value = true
  const replace = await new Promise<boolean>((resolve) =>
    uni.showModal({
      title: '替换当前账本？',
      content: '将用这份备份替换全部账户和记录，当前账本会保留一份副本。',
      confirmText: '替换并恢复',
      success: (result) => resolve(result.confirm),
      fail: () => resolve(false),
    }),
  )
  if (!replace) {
    busy.value = false
    return
  }
  error.value = ''
  message.value = ''
  try {
    await restoreBook(originalText.value, expectedRevision.value)
    clearFormDraft('backup-preview')
    preview.value = undefined
    originalText.value = ''
    message.value = '账本已恢复，原账本副本已保留。'
    showToast('账本已恢复')
    await loadRecovery()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '恢复失败，当前账本未改变'
  } finally {
    busy.value = false
  }
}
/** 取消预检只释放文件内容，不清空现有账本或上次操作前副本。 */
function cancelPreview(): void {
  clearFormDraft('backup-preview')
  preview.value = undefined
  originalText.value = ''
  error.value = ''
}
/** 文件预检不是恢复授权；再次打开保留文件内容，但必须重新确认覆盖。 */
interface PreviewDraft {
  text: string
  source: string
  revision: number
}
try {
  const draft = readFormDraft<PreviewDraft>('backup-preview')
  if (draft) {
    inspect(draft.text, draft.source)
    expectedRevision.value = draft.revision
  }
} catch {
  error.value = '备份草稿无法读取，请重新选择文件；当前账本未改变'
}
onBeforeUnmount(() => {
  if (originalText.value) {
    try {
      saveFormDraft('backup-preview', {
        text: originalText.value,
        source: source.value,
        revision: expectedRevision.value,
      })
    } catch {
      showToast('备份预检草稿保存失败，请保留原备份文件')
    }
  }
})
void loadRecovery()
</script>
<template>
  <view class="backup-panel">
    <view class="backup-body">
      <view class="tip"
        >将账户、持仓基准、资金流水、全部成交和投资计划保存为本地文件，方便换设备或重新安装后恢复。</view
      >
      <view class="backup-summary"
        ><view class="metric-grid"
          ><view
            ><view class="metric-label">本机账户</view
            ><view class="metric-value">{{ bookState.data.accounts.length }} 个</view></view
          ><view
            ><view class="metric-label">交易记录</view
            ><view class="metric-value">{{ bookState.data.trades.length }} 笔</view></view
          ></view
        ></view
      >

      <view v-if="preview && summary" class="backup-preview">
        <view class="row"
          ><text class="asset-name">备份预检通过</text
          ><text class="badge">完整性校验通过</text></view
        >
        <view class="sub backup-file-name">{{ source }}</view><view class="sub"
          >导出时间 {{ formatDateTime(preview.createdAt) }}</view
        >
        <view class="metric-grid" style="margin-top: 14px"
          ><view
            ><view class="metric-label">账户 / 持仓</view
            ><view class="metric-value"
              >{{ summary.accounts }} / {{ summary.positions }}</view
            ></view
          ><view
            ><view class="metric-label">交易 / 计划</view
            ><view class="metric-value">{{ summary.trades }} / {{ summary.plans }}</view></view
          ><view
            ><view class="metric-label">备份中现金合计（元）</view
            ><view class="metric-value">{{ formatMoney(summary.cash) }}</view></view
          ></view
        >
        <view class="tip"
          >恢复会整体替换本机 {{ bookState.data.accounts.length }} 个账户、{{
            bookState.data.trades.length
          }}
          笔记录和
          {{ bookState.data.plans.length }}
          个计划。恢复前账本会自动保留一份，可在下方再次预检恢复。</view
        >
        <template v-if="changed"
          ><view class="error" role="alert">本机账本在预检后有更新，请重新预检再恢复。</view
          ><button class="secondary full" :disabled="busy" @click="reinspect">
            重新预检
          </button></template
        >
      </view>
      <view v-if="recovery" class="backup-recovery"
        ><view class="row"
          ><text class="asset-name">上次操作前副本</text
          ><text class="badge">保留最近一次</text></view
        ><view class="sub">{{ formatDateTime(recovery.createdAt) }}</view
        ><button class="secondary full" :disabled="busy" @click="previewRecovery">
          预检操作前账本
        </button></view
      >
    </view>
    <view class="sheet-footer backup-footer">
      <view v-if="message" class="tip backup-message" role="status">{{ message }}</view><view
        v-if="error"
        class="error"
        role="alert"
        >{{ error }}</view
      >
      <template v-if="preview && summary">
        <button class="primary full" :disabled="busy || !!changed" @click="confirmRestore">
          恢复此备份</button
        ><button class="secondary full" :disabled="busy" @click="cancelPreview">取消恢复</button>
      </template>
      <template v-else>
        <button class="primary full" :disabled="busy || !bookState.ready" @click="download">
          {{ busy ? '处理中…' : '导出账本备份' }}
        </button>
        <button class="secondary full" :disabled="busy || !bookState.ready" @click="selectFile">
          选择备份文件恢复
        </button>
      </template>
    </view>
  </view>
</template>
