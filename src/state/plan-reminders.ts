import { computed, ref, watch } from 'vue'
import { describePlanReminder } from '../domain/plan-reminder'
import { positionKey } from '../domain/book'
import { bookState, projection, selectedAccountId } from './book'
import { watchState } from './watchlist'
import { appVisible } from './app-visibility'

const clock = ref(Date.now())
let timer: ReturnType<typeof setInterval> | undefined
// 仅更新展示的新鲜度，不发请求、不在后台采集行情；防止静止页面长期显示过期建议。
watch(
  appVisible,
  (visible) => {
    clearInterval(timer)
    timer = undefined
    clock.value = Date.now()
    if (visible)
      timer = setInterval(() => {
        clock.value = Date.now()
      }, 30000)
  },
  { immediate: true },
)

/** 所有页面共用同一提醒口径；账户筛选只改变展示，不改变已保存的策略信号。 */
export const allPlanReminders = computed(() =>
  bookState.data.plans.map((plan) => ({
    plan,
    ...describePlanReminder(
      plan,
      projection.value.plans[plan.id],
      projection.value.positions[positionKey(plan.accountId, plan.instrumentId)],
      bookState.data.trades,
      watchState.cache[plan.instrumentId]?.quote,
      watchState.errors[plan.instrumentId],
      Math.max(clock.value, Date.now()),
    ),
  })),
)
/** 首页和计划Tab保持相同账户范围；详情按计划ID从全量投影定位。 */
export const planReminders = computed(() =>
  allPlanReminders.value.filter(
    (row) => !selectedAccountId.value || row.plan.accountId === selectedAccountId.value,
  ),
)
