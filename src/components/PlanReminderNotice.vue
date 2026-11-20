<script setup lang="ts">
import type { PlanReminder } from '../domain/plan-reminder'
import { formatMoney } from '../domain/money'
defineProps<{ reminder: PlanReminder }>()
</script>
<template>
  <view class="reminder-notice" :class="{ triggered: reminder.actionable }">
    <view class="reminder-title">{{ reminder.title }}</view>
    <view v-if="reminder.message" class="reminder-message">{{ reminder.message }}</view>
    <view v-if="reminder.threshold && reminder.kind !== 'verify'" class="reminder-basis">
      {{ reminder.thresholdLabel }} {{ formatMoney(reminder.threshold, 4) }}
      <text v-if="reminder.quoteValue"> · {{ reminder.priceLabel }} {{ reminder.quoteValue }}</text>
    </view>
    <slot />
  </view>
</template>
<style scoped>
.reminder-notice {
  padding: 14px;
  border-radius: 12px;
  background: #f5f7fc;
}
.reminder-notice.triggered {
  background: #eef3ff;
}
.reminder-title {
  font-size: 15px;
  font-weight: 700;
  color: #43516b;
}
.triggered .reminder-title {
  color: #2858df;
}
.reminder-message {
  margin-top: 7px;
  font-size: 13px;
  line-height: 1.6;
  color: #43516b;
}
.reminder-basis {
  margin-top: 6px;
  font-size: 14px;
  color: #75849c;
  line-height: 1.6;
  overflow-wrap: anywhere;
}
</style>
