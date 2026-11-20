import type { HistoryPoint } from './market'
import { goldToday } from './gold-history'

/** 按北京时间标注上金所常规时段；无节假日日历时不将时段标签当作可交易判断。 */
export function sgeSessionLabel(now: Date): string {
  const local = new Date(now.getTime() + 8 * 3600000)
  const weekday = local.getUTCDay()
  const minute = local.getUTCHours() * 60 + local.getUTCMinutes()
  if (weekday === 0 || (weekday === 6 && minute >= 150)) return '周末休市'
  if (minute < 150 && weekday !== 1) return '夜盘时段 · 延时行情'
  if (weekday === 6) return '周末休市'
  if (minute < 540) return '日盘待开 · 09:00 开盘'
  if (minute < 930) return '日盘时段 · 延时行情'
  if (minute < 1200) return '日盘已收盘 · 20:00 开盘'
  return '夜盘时段 · 延时行情'
}

/** 显示来源完整交易曲线，保留前一晚和凌晨；跨午夜短暂未更新时仍保留昨夜夜盘。 */
export function sgeMinutePoints(points: HistoryPoint[], now: Date): HistoryPoint[] {
  const last = points[points.length - 1]
  if (!last) return []
  const today = goldToday(now)
  if (last.date.slice(0, 10) === today) return points
  const localHour = new Date(now.getTime() + 8 * 3600000).getUTCHours()
  const yesterday = goldToday(new Date(now.getTime() - 86400000))
  return localHour < 3 && last.date.slice(0, 10) === yesterday && last.date.slice(11) >= '20:00'
    ? points
    : []
}
