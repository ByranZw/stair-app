<script setup lang="ts">
import { computed } from 'vue'
import { appUpdateState } from '../state/app-update'
const visible = computed(() => appUpdateState.phase === 'available' && !appUpdateState.dismissed)
/** 仅进入更新页，不下载、不关闭或提交当前交易表单。 */
function viewUpdate(): void {
  uni.navigateTo({ url: '/pages/update/index' })
}
</script>
<template>
  <view v-if="visible" class="update-notice">
    <button class="update-link" @click="viewUpdate">
      发现新版 {{ appUpdateState.release?.version }} · 查看更新
    </button>
    <button class="update-later" @click="appUpdateState.dismissed = true">稍后</button>
  </view>
</template>
<style scoped>
.update-notice {
  position: fixed;
  left: 16px;
  right: 16px;
  bottom: calc(82px + env(safe-area-inset-bottom));
  z-index: 90;
  display: flex;
  align-items: center;
  background: #eaf0ff;
  border: 1px solid #c8d8ff;
  border-radius: 13px;
  padding: 8px;
  box-shadow: 0 4px 16px #2858df15;
}
.update-link,
.update-later {
  background: transparent;
  color: #2858df;
  font-size: 13px;
  padding: 5px 8px;
  line-height: 1.5;
  margin: 0;
}
.update-link {
  flex: 1;
  text-align: left;
}
.update-later {
  flex-shrink: 0;
  color: #71809b;
}
</style>
