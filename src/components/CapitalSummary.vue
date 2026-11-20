<script setup lang="ts">
import { computed } from 'vue'
import { bookState, projection, selectedAccountId } from '../state/book'
import { summarizeCapital } from '../domain/capital'
import { D, formatMoney } from '../domain/money'
const props = defineProps<{ hidden?: boolean; market?: string; budgetView?: boolean }>()
defineEmits<{ funding: []; accounts: [] }>()
const capital = computed(() =>
  summarizeCapital(bookState.data, projection.value, selectedAccountId.value),
)
const deficit = computed(() => new D(capital.value.free).lt(0))
const accountDeficit = computed(
  () => capital.value.accounts.length > 1 && new D(capital.value.shortfall).gt(0),
)
/** 金额隐藏覆盖所有派生值；缺口以正金额展示，保留真实负值用于判断。 */
function amount(value: string, absolute = false): string {
  return props.hidden ? '••••' : formatMoney(absolute ? new D(value).abs().toString() : value)
}
</script>
<template>
  <view class="capital-summary">
    <button class="capital-entry" @click="$emit('funding')">
      <template v-if="budgetView">
        <view
          ><text class="capital-label">计划预算</text
          ><text class="num">¥{{ amount(capital.budget) }}</text></view
        >
        <view
          ><text class="capital-label">待投入</text
          ><text class="num">¥{{ amount(capital.remaining) }} ›</text></view
        >
      </template>
      <template v-else>
        <text class="capital-label">{{ deficit ? '预算缺口' : '未分配资金' }}</text>
        <text class="num" :class="{ warning: deficit }">¥{{ amount(capital.free, true) }} ›</text>
      </template>
    </button>
    <button
      v-if="(budgetView && deficit) || accountDeficit"
      class="capital-warning"
      @click="$emit('funding')"
    >
      {{ budgetView && deficit ? '预算缺口' : accountDeficit ? '部分账户预算不足' : '预算已超配' }}
      ¥{{ amount(deficit ? capital.free : capital.shortfall, true) }} ›
    </button>
  </view>
</template>
<style scoped>
.capital-summary {
  margin-bottom: 12px;
}
.capital-entry {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 13px 16px;
  border-radius: 12px;
  background: #fff;
  font-size: 14px;
  color: #283750;
}
.capital-entry > view {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.capital-label {
  color: #75849c;
}
.warning {
  color: #b5652c;
}
.capital-warning {
  width: 100%;
  margin-top: 6px;
  padding: 4px 12px;
  background: transparent;
  color: #a45e20;
  font-size: 13px;
  text-align: left;
}
</style>
