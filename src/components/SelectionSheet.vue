<script setup lang="ts">
import { computed, inject, ref, watch } from 'vue'
import BottomSheet from './BottomSheet.vue'
import { useSelection } from '../composables/useSelection'
import { pickerDate, pickerDateColumns } from '../domain/picker-date'
import { today } from '../domain/money'
import { sheetBackKey } from '../composables/useSheetBack'
const { request, visible, tabPage } = useSelection()
const backStack = inject(sheetBackKey)
const hideTab = ref(false)
const chosen = ref(''),
  query = ref('')
const start = computed(() => request.value?.start || '1900-01-01')
const end = computed(() => request.value?.end || '2100-12-31')
const timeMode = computed(() => request.value?.mode === 'time')
const columns = computed(() =>
  timeMode.value
    ? [Array.from({ length: 24 }, (_, i) => i), Array.from({ length: 60 }, (_, i) => i)]
    : pickerDateColumns(chosen.value || today(), start.value, end.value),
)
const indices = computed(() => {
  const values = chosen.value.split(timeMode.value ? ':' : '-').map(Number)
  return columns.value.map((items, i) => Math.max(0, items.indexOf(values[i])))
})
const options = computed(() =>
  (request.value?.options || [])
    .map((label, index) => ({ label, index }))
    .filter((item) => item.label.toLowerCase().includes(query.value.toLowerCase())),
)
watch(request, (current) => {
  query.value = ''
  if (!current) return
  hideTab.value = tabPage && !backStack?.hasLayers()
  if (current.mode === 'date')
    chosen.value = pickerDate(
      (current.value || today()).split('-').map(Number),
      start.value,
      end.value,
    )
  else if (current.mode === 'time') {
    const now = new Date()
    chosen.value =
      current.value ||
      `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  } else chosen.value = current.value || '0'
})
/** 动态年月按旧列索引读值，再收敛月末和可选日期边界。 */
function changeWheel(event: { detail: { value: number[] } }): void {
  const values = columns.value.map((items, i) => items[event.detail.value[i]] ?? items[0])
  chosen.value = timeMode.value
    ? values.map((n) => String(n).padStart(2, '0')).join(':')
    : pickerDate(values, start.value, end.value)
}
/** 只有确认或点选列表才通知字段，蒙版和系统返回只关闭选择面板。 */
function select(value: string): void {
  request.value?.select(value)
  visible.value = false
}
</script>
<template>
  <BottomSheet
    v-model="visible"
    :title="request?.title || '请选择'"
    :tab-page="hideTab"
    class="selection-overlay"
  >
    <template v-if="request?.mode === 'selector'">
      <input
        v-if="request.options.length > 8"
        v-model="query"
        class="search-input selection-search"
        placeholder="搜索选项"
      />
      <view class="selection-list">
        <button
          v-for="option in options"
          :key="option.index"
          class="selection-option"
          :class="{ selected: String(option.index) === chosen }"
          @click="select(String(option.index))"
        >
          <text>{{ option.label }}</text><text class="selection-check">{{
            String(option.index) === chosen ? '✓' : ''
          }}</text>
        </button>
        <view v-if="!options.length" class="empty">暂无选项</view>
      </view>
    </template>
    <template v-else>
      <view class="selection-preview">{{
        timeMode ? chosen : chosen.replace('-', '年').replace('-', '月') + '日'
      }}</view>
      <view class="wheel-labels"
        ><text v-for="label in timeMode ? ['时', '分'] : ['年', '月', '日']" :key="label">{{
          label
        }}</text></view
      >
      <picker-view
        class="selection-wheel"
        :value="indices"
        indicator-class="selection-indicator"
        indicator-style="height: 48px; background: rgba(40,88,223,.06); border-radius: 12px;"
        mask-style="background-image: linear-gradient(to bottom, white, rgba(255,255,255,0)), linear-gradient(to top, white, rgba(255,255,255,0));"
        @change="changeWheel"
      >
        <picker-view-column v-for="(items, column) in columns" :key="column">
          <view v-for="item in items" :key="item" class="wheel-item">{{
            column === 0 && !timeMode ? item : String(item).padStart(2, '0')
          }}</view>
        </picker-view-column>
      </picker-view>
    </template>
    <template v-if="request?.mode !== 'selector'" #footer>
      <view class="selection-actions"
        ><button class="secondary" @click="visible = false">取消</button
        ><button class="primary" @click="select(chosen)">确认</button></view
      >
    </template>
  </BottomSheet>
</template>
<style>
.selection-overlay.overlay {
  z-index: 1300;
}
.selection-overlay .sheet {
  max-height: 72%;
}
.selection-overlay .sheet-body {
  padding-bottom: 18px;
}
.selection-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-bottom: calc(22px + env(safe-area-inset-bottom));
}
.selection-search {
  margin-bottom: 12px;
}
.selection-option {
  width: 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  text-align: left;
  min-height: 54px;
  padding: 14px 16px;
  margin: 0;
  border-radius: 12px;
  font-size: 15px;
  line-height: 1.5;
  background: #f7f9fc;
  color: #23314b;
}
.selection-option.selected {
  background: #edf2ff;
  color: #2858df;
  font-weight: 600;
}
.selection-check {
  flex-shrink: 0;
  width: 24px;
  margin-left: 12px;
  font-size: 18px;
  text-align: center;
}
.selection-preview {
  text-align: center;
  font-size: 26px;
  font-weight: 700;
  color: #23314b;
  padding: 8px 0 20px;
  font-variant-numeric: tabular-nums;
}
.wheel-labels {
  display: flex;
  color: #8793a8;
  font-size: 13px;
  text-align: center;
}
.wheel-labels text {
  flex: 1;
}
.selection-wheel {
  height: 228px;
  width: 100%;
}
.wheel-item {
  height: 48px;
  line-height: 48px;
  text-align: center;
  color: #23314b;
  font-size: 22px;
  font-weight: 500;
  font-variant-numeric: tabular-nums;
}
.selection-indicator::before,
.selection-indicator::after {
  border: none;
}
.selection-actions {
  display: flex;
  gap: 12px;
}
.selection-actions button {
  flex: 1;
  min-height: 46px;
  border-radius: 14px;
  font-size: 16px;
}
.selection-actions .primary {
  flex: 2;
}
</style>
