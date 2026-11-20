<script setup lang="ts">
import AppIcon from './AppIcon.vue'
const props = withDefaults(defineProps<{ modelValue: string; busy?: boolean; focus?: boolean }>(), {
  busy: false,
  focus: false,
})
const emit = defineEmits<{ 'update:modelValue': [value: string]; search: [] }>()
/** 输入只更新检索词，查询仍由明确提交触发。 */
function input(event: Event): void {
  emit('update:modelValue', (event as unknown as { detail: { value: string } }).detail.value)
}
/** 键盘与按钮走同一入口，空白输入和查询中的重复提交不发请求。 */
function submit(): void {
  if (props.modelValue.trim() && !props.busy) emit('search')
}
</script>
<template>
  <view class="search-field">
    <view class="search-field-entry">
      <AppIcon name="search" tone="muted" />
      <input
        :value="modelValue"
        class="search-field-input"
        :focus="focus"
        placeholder="名称 / 代码"
        placeholder-class="search-field-placeholder"
        maxlength="40"
        confirm-type="search"
        aria-label="搜索投资标的名称或代码"
        @input="input"
        @confirm="submit"
      />
      <button
        v-if="modelValue"
        class="search-field-clear"
        aria-label="清空搜索"
        @click="emit('update:modelValue', '')"
      >
        ×
      </button>
    </view>
    <button class="search-field-submit" :disabled="busy || !modelValue.trim()" @click="submit">
      {{ busy ? '查询中' : '搜索' }}
    </button>
  </view>
</template>
<style scoped>
.search-field {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  margin: 14px 0 18px;
}
.search-field-entry {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  height: 46px;
  padding: 0 12px;
  gap: 8px;
  border-radius: 12px;
  background: #f1f4f9;
  border: 1px solid transparent;
}
.search-field-entry:focus-within {
  background: #f7f9ff;
  border-color: #b6c8f3;
}
.search-field-entry .icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}
.search-field-input {
  flex: 1;
  width: 0;
  min-width: 0;
  height: 44px;
  min-height: 44px;
  padding: 0;
  font-size: 14px;
  color: #19263e;
  background: transparent;
}
.search-field-clear {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 36px;
  padding: 0;
  flex-shrink: 0;
  background: transparent;
  color: #8490a5;
  font-size: 21px;
}
.search-field-submit {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  width: 68px;
  height: 46px;
  padding: 0;
  border-radius: 12px;
  background: #edf2ff;
  color: #2858df;
  font-size: 14px;
  font-weight: 600;
  line-height: 1.5;
}
.search-field-submit[disabled] {
  opacity: 0.55;
}
</style>
