<script setup lang="ts">
import { computed, ref } from 'vue'
import { appUpdater, appUpdateState as state } from '../../state/app-update'
import { androidUpdateSupported } from '../../services/android-update'
import { usePageDialog } from '../../composables/useDialog'
import { usePageSheetBack } from '../../composables/useSheetBack'
import AppDialog from '../../components/AppDialog.vue'
usePageSheetBack()
const dialog = usePageDialog()
const supported = androidUpdateSupported()
const installing = ref(false)
/** 返回之前的页面，不停止用户已明确开始的下载。 */
function goBack(): void {
  uni.navigateBack()
}
const busy = computed(
  () => ['checking', 'downloading', 'verifying'].includes(state.phase) || installing.value,
)
const newer = computed(
  () => state.release && state.phase !== 'current' && state.phase !== 'checking',
)
const status = computed(
  () =>
    ({
      idle: '尚未检查',
      checking: '正在连接GitHub…',
      current: '当前已是最新正式版',
      available: '发现新版本',
      downloading: '正在下载安装包',
      verifying: '正在校验安装包…',
      ready: '安装包校验通过',
      error: '更新未完成',
    })[state.phase],
)
/** 用户明确确认备份提示后才调用原生安装；授权后仍需再次点击确认。 */
async function confirmInstall(): Promise<void> {
  if (installing.value) return
  installing.value = true
  try {
    const confirmed = await dialog.confirm({
      title: state.permissionNeeded ? '继续安装更新' : '安装更新',
      message: '请先在“我的 → 数据备份与恢复”导出账本。覆盖安装通常保留数据，不要卸载旧版。',
      detail:
        '系统会要求确认安装。若需允许本应用安装来源，请授权后返回，再点击继续安装；取消不会影响记账。',
      confirmText: '已备份，继续',
    })
    if (confirmed) await appUpdater.install()
  } finally {
    installing.value = false
  }
}
</script>
<template>
  <view class="screen update-page">
    <view class="page-head"
      ><button class="update-back" @click="goBack">‹ 返回</button
      ><view class="page-title">应用更新</view></view
    >
    <view class="card update-card">
      <view class="update-heading">拾阶 STAIR</view>
      <view class="muted">当前版本 {{ state.currentVersion }} · ARM64</view>
      <view class="update-status">{{ supported ? status : 'App内更新仅支持安卓安装版' }}</view>
      <view class="tip"
        >安装包来自 GitHub
        正式发布。每天最多自动检查一次，也可手动检查；不会自动下载或强制安装。</view
      >
      <button class="secondary full" :disabled="busy || !supported" @click="appUpdater.check(true)">
        {{ state.phase === 'checking' ? '检查中…' : '检查更新' }}
      </button>
    </view>
    <view v-if="newer" class="card update-card">
      <view class="update-heading">新版本 {{ state.release?.version }}</view>
      <view class="muted"
        >安装包 {{ ((state.release?.size || 0) / 1024 / 1024).toFixed(1) }} MB · Android 5.0+</view
      >
      <view class="update-notes">{{ state.release?.notes }}</view>
      <template v-if="state.phase === 'downloading' || state.phase === 'verifying'">
        <progress :percent="state.progress" stroke-width="5" activeColor="#2858df" />
        <view class="tip">{{
          state.phase === 'verifying'
            ? '下载完成，正在校验SHA-256及应用版本'
            : `已下载 ${state.progress}%`
        }}</view>
        <button
          v-if="state.phase === 'downloading'"
          class="secondary full"
          @click="appUpdater.cancel()"
        >
          取消下载
        </button>
      </template>
      <button
        v-else-if="state.phase !== 'ready'"
        class="primary full"
        :disabled="busy || !supported"
        @click="appUpdater.download()"
      >
        {{ state.phase === 'error' ? '重新下载安装包' : '下载安装包' }}
      </button>
      <template v-else>
        <view class="tip">SHA-256、文件大小、应用及版本校验通过。安卓系统还会校验应用签名。</view>
        <view v-if="state.permissionNeeded" class="tip"
          >请在系统设置允许“此来源的应用”，返回后点击继续安装。若未授权，可照常返回记账。</view
        >
        <view v-if="state.installerOpened" class="tip"
          >已请求系统安装，请在系统界面确认；取消或返回不代表更新成功。</view
        >
        <button class="primary full" :disabled="installing" @click="confirmInstall">
          {{ installing ? '请稍候…' : state.permissionNeeded ? '继续安装' : '确认安装更新' }}
        </button>
      </template>
    </view>
    <view v-if="state.error" class="card update-card error">{{ state.error }}</view>
    <view class="tip update-foot"
      >检查或下载失败不影响记账。产生负现金或超预算记录后，不要降级到0.1.12及更早版本。</view
    >
    <AppDialog />
  </view>
</template>
<style scoped>
.update-page {
  padding-bottom: 32px;
}
.update-back {
  background: transparent;
  color: #2858df;
  padding: 0 14px 0 0;
  margin: 0;
  line-height: 1.5;
  font-size: 16px;
}
.update-card {
  padding: 20px 18px;
}
.update-heading {
  font-size: 18px;
  font-weight: 700;
  margin-bottom: 8px;
}
.update-status {
  margin: 18px 0 10px;
  font-weight: 600;
  color: #2858df;
}
.update-notes {
  font-size: 14px;
  line-height: 1.8;
  white-space: pre-line;
  overflow-wrap: anywhere;
  margin: 18px 0;
}
.full {
  margin-top: 16px;
}
.update-foot {
  padding: 0 5px;
}
</style>
