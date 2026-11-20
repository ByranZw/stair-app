<script setup lang="ts">
import { useSelection } from '../composables/useSelection'
const props = withDefaults(
  defineProps<{
    title?: string
    mode?: 'selector' | 'date' | 'time'
    range?: unknown[]
    rangeKey?: string
    value?: string | number
    start?: string
    end?: string
    disabled?: boolean
  }>(),
  { mode: 'selector', range: () => [], value: '', start: '', end: '' },
)
const emit = defineEmits<{ change: [event: { detail: { value: string } }] }>()
const selection = useSelection()
/** 保持原picker的change契约，日期/时间取消不会改写下层表单。 */
function open(): void {
  if (props.disabled) return
  uni.hideKeyboard()
  selection.request.value = {
    title:
      props.title ||
      (props.mode === 'date' ? '选择日期' : props.mode === 'time' ? '成交时间' : '请选择'),
    mode: props.mode,
    options: props.range.map((item) =>
      props.rangeKey ? String((item as Record<string, unknown>)[props.rangeKey]) : String(item),
    ),
    value: String(props.value),
    start: props.start,
    end: props.end,
    select: (value) => emit('change', { detail: { value } }),
  }
  selection.visible.value = true
}
</script>
<template>
  <view
    class="app-picker"
    :class="{ 'picker-disabled': disabled }"
    role="button"
    :aria-label="title"
    :aria-disabled="disabled"
    @click="open"
    ><slot
  /></view>
</template>
<style scoped>
.picker-disabled {
  opacity: 0.55;
}
</style>
