/** 将滚轮的年月日收敛到真实日期与允许范围，月末切换不滚入下个月。 */
export function pickerDate(parts: number[], start: string, end: string): string {
  const [year, month, day] = parts
  const last = new Date(year, month, 0).getDate()
  const date = [year, month, Math.min(day, last)]
    .map((n, i) => String(n).padStart(i ? 2 : 4, '0'))
    .join('-')
  return date < start ? start : date > end ? end : date
}
/** 日期三列随当前年月和首尾边界联动，不展示不可选择的未来日期。 */
export function pickerDateColumns(value: string, start: string, end: string): number[][] {
  const [year, month] = value.split('-').map(Number)
  const [firstYear, firstMonth, firstDay] = start.split('-').map(Number)
  const [lastYear, lastMonth, lastDay] = end.split('-').map(Number)
  const sequence = (from: number, to: number) =>
    Array.from({ length: to - from + 1 }, (_, i) => from + i)
  return [
    sequence(firstYear, lastYear),
    sequence(year === firstYear ? firstMonth : 1, year === lastYear ? lastMonth : 12),
    sequence(
      year === firstYear && month === firstMonth ? firstDay : 1,
      year === lastYear && month === lastMonth ? lastDay : new Date(year, month, 0).getDate(),
    ),
  ]
}
