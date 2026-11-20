<script setup lang="ts">
import { inject, ref, watch } from 'vue'
import BottomSheet from './BottomSheet.vue'
import { useDialog } from '../composables/useDialog'
import { sheetBackKey } from '../composables/useSheetBack'
const dialog = useDialog()
const { request, visible } = dialog
const stack = inject(sheetBackKey)
const hideTab = ref(false)
watch(
  request,
  (value) => {
    if (value) {
      uni.hideKeyboard()
      hideTab.value = dialog.tabPage && !stack?.hasLayers()
    }
  },
  { flush: 'sync' },
)
/** 所有取消入口复用同一结果，保留下层表单和滚动位置。 */
function dismiss(value: boolean): void {
  if (!value) dialog.answer(false)
}
/** 按钮只确认当前记录，退场完毕后才开始业务操作。 */
function confirm(): void {
  dialog.answer(true)
}
</script>
<template>
  <BottomSheet
    :model-value="visible"
    :title="request?.title || ''"
    variant="dialog"
    :tab-page="hideTab"
    @update:model-value="dismiss"
    @closed="dialog.finish"
  >
    <view v-if="request?.message" class="dialog-message">{{ request.message }}</view>
    <view v-if="request?.detail" class="dialog-detail">{{ request.detail }}</view>
    <template #footer>
      <view class="dialog-actions" :class="{ 'dialog-actions-single': request?.alert }">
        <button v-if="!request?.alert" class="secondary" @click="dialog.answer(false)">取消</button>
        <button :class="request?.destructive ? 'dialog-danger' : 'primary'" @click="confirm">
          {{ request?.confirmText || (request?.alert ? '知道了' : '确认') }}
        </button>
      </view>
    </template>
  </BottomSheet>
</template>
<style scoped>
.dialog-message {
  color: #71809b;
  font-size: 14px;
  line-height: 1.7;
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.dialog-detail {
  margin-top: 14px;
  background: #f5f7fc;
  border-radius: 13px;
  padding: 14px;
  color: #4c5c76;
  font-size: 13px;
  line-height: 1.8;
  white-space: pre-line;
  overflow-wrap: anywhere;
}
.dialog-actions {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}
.dialog-actions-single {
  grid-template-columns: 1fr;
}
.dialog-actions button {
  min-height: 46px;
  padding: 12px 10px;
  font-size: 15px;
  line-height: 1.5;
  border-radius: 13px;
  margin: 0;
}
.dialog-danger {
  background: #d94d5d;
  color: #fff;
  font-weight: 600;
}
</style>
