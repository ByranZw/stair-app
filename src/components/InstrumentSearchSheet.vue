<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import BottomSheet from './BottomSheet.vue'
import { searchInstruments } from '../services/market'
import type { Instrument } from '../domain/market'

const props = defineProps<{ modelValue: boolean; items: Instrument[]; selectedId: string }>()
const emit = defineEmits<{
  'update:modelValue': [value: boolean]
  select: [item: Instrument]
}>()
const query = ref(''),
  type = ref<'ETF' | 'FUND' | 'GOLD'>('ETF'),
  results = ref<Instrument[]>([]),
  busy = ref(false),
  searched = ref(false),
  error = ref('')
let version = 0
const local = computed(() =>
  props.items.filter(
    (item) =>
      item.type === type.value &&
      `${item.name} ${item.code}`.toLowerCase().includes(query.value.trim().toLowerCase()),
  ),
)
const options = computed(() => [
  ...new Map([...local.value, ...results.value].map((item) => [item.id, item])).values(),
])
/** 切换类别保留检索词，黄金无需远程检索，直接展示内置账户。 */
function setType(value: 'ETF' | 'FUND' | 'GOLD'): void {
  type.value = value
  if (value === 'GOLD') query.value = ''
}
// 改变检索上下文或关闭时使旧请求失效，避免迟到结果覆盖新选择。
watch(
  () => [query.value, type.value, props.modelValue],
  () => {
    version++
    results.value = []
    busy.value = false
    searched.value = false
    error.value = ''
  },
  { flush: 'sync' },
)
/** 仅主动提交才请求免费检索源；已选标的在父表单中保存，搜索不创建关注或持仓。 */
async function search(): Promise<void> {
  if (type.value === 'GOLD') return
  const current = ++version
  busy.value = true
  searched.value = true
  error.value = ''
  results.value = []
  try {
    const rows = await searchInstruments(query.value, type.value)
    if (current === version) results.value = rows
  } catch (e) {
    if (current === version) error.value = e instanceof Error ? e.message : '搜索失败，请重试'
  } finally {
    if (current === version) busy.value = false
  }
}
/** 选择只回填身份并关闭当前层；自动加自选由持仓保存成功后执行。 */
function select(item: Instrument): void {
  emit('select', item)
  emit('update:modelValue', false)
}
</script>
<template>
  <BottomSheet
    :model-value="modelValue"
    title="选择投资标的"
    @update:model-value="emit('update:modelValue', $event)"
  >
    <view class="filters">
      <button :class="{ active: type === 'ETF' }" @click="setType('ETF')">场内 ETF</button>
      <button :class="{ active: type === 'FUND' }" @click="setType('FUND')">场外基金</button>
      <button :class="{ active: type === 'GOLD' }" @click="setType('GOLD')">积存金</button>
    </view>
    <view v-if="type !== 'GOLD'" class="search-bar">
      <input
        v-model="query"
        class="search-input"
        placeholder="搜索代码 / 基金名称"
        maxlength="40"
        confirm-type="search"
        @confirm="search"
      />
      <button class="small-action" :disabled="busy" @click="search">
        {{ busy ? '查询中' : '搜索' }}
      </button>
    </view>
    <view v-if="error" class="error">{{ error }}</view>
    <button
      v-for="item in options"
      :key="item.id"
      class="instrument-option full"
      :class="{ chosen: item.id === selectedId }"
      @click="select(item)"
    >
      <view
        ><view class="asset-name">{{ item.name }}</view
        ><view class="position-code"
          >{{ item.code }} ·
          {{ item.type === 'ETF' ? 'ETF' : item.type === 'FUND' ? '场外基金' : '积存金' }}</view
        ></view
      >
      <text v-if="item.id === selectedId" class="blue">✓</text>
    </button>
    <view v-if="!options.length && !busy && !error" class="empty">{{
      searched ? '没有匹配的标的，试试完整代码' : '输入名称或代码搜索'
    }}</view>
  </BottomSheet>
</template>
<style scoped>
.instrument-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  text-align: left;
  padding: 15px;
  margin-top: 10px;
  background: #f7f9fd;
  border: 1px solid #edf0f7;
  border-radius: 12px;
}
.instrument-option.chosen {
  background: #eef2ff;
  border-color: #cdd7ff;
}
</style>
