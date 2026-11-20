<script setup lang="ts">
import { instrumentLabel, currencyOf } from '../../domain/currency'
import PageOverlays from '../../components/PageOverlays.vue'
import { usePageSelection } from '../../composables/useSelection'
usePageSelection(true)
import { usePageDialog } from '../../composables/useDialog'
import { usePageSheetBack } from '../../composables/useSheetBack'
usePageSheetBack()
const dialog = usePageDialog(true)
import { computed, ref, watch } from 'vue'
import { onShow, onHide } from '@dcloudio/uni-app'
import { watchState, addInstrument, removeInstrument, refreshAll } from '../../state/watchlist'
import { searchInstruments } from '../../services/market'
import type { Instrument } from '../../domain/market'
import AppIcon from '../../components/AppIcon.vue'
import AppToast from '../../components/AppToast.vue'
import { showToast } from '../../state/feedback'
import SearchField from '../../components/SearchField.vue'
import BottomSheet from '../../components/BottomSheet.vue'
import HistoryChart from '../../components/HistoryChart.vue'
const searching = ref(false),
  query = ref(''),
  type = ref<'ETF' | 'FUND' | 'STOCK'>('ETF'),
  results = ref<Instrument[]>([]),
  busy = ref(false),
  searched = ref(false),
  error = ref(''),
  filter = ref('全部'),
  pressed = ref(''),
  removing = ref(false)
const visible = computed(() =>
  watchState.items.filter(
    (item) =>
      filter.value === '全部' ||
      (filter.value === 'ETF' && item.type === 'ETF') ||
      (filter.value === '股票' && item.type === 'STOCK') ||
      (filter.value === '场外基金' && item.type === 'FUND') ||
      (filter.value === '积存金' && item.type === 'GOLD'),
  ),
)
let searchVersion = 0
let suppressClickUntil = 0
// 检索词变化时清掉旧结果并作废在途请求，清空后不残留上一次的匹配项。
watch(
  query,
  () => {
    searchVersion++
    results.value = []
    busy.value = false
    searched.value = false
    error.value = ''
  },
  { flush: 'sync' },
)

const chartVisible = ref(true)
// Tab保留页面实例；隐藏时停止Canvas测量，避免用详情页上下文查询迷你图。
onShow(() => {
  chartVisible.value = true
})
onHide(() => {
  chartVisible.value = false
  pressed.value = ''
})
/** 筛选切换丢弃过时搜索，不把其他类型的返回值留在当前结果。 */
function setType(value: 'ETF' | 'FUND' | 'STOCK') {
  type.value = value
  results.value = []
  searched.value = false
  error.value = ''
  busy.value = false
  searchVersion++
}
/** 用户提交才查询，序号保证旧响应不覆盖当前筛选。 */
async function search() {
  const version = ++searchVersion
  busy.value = true
  error.value = ''
  results.value = []
  searched.value = true
  try {
    const rows = await searchInstruments(query.value, type.value)
    if (version === searchVersion) results.value = rows
  } catch (e) {
    if (version === searchVersion) error.value = e instanceof Error ? e.message : '搜索失败'
  } finally {
    if (version === searchVersion) busy.value = false
  }
}
/** 加关注只保存本地清单，不生成持仓、计划或成交。 */
function add(item: Instrument) {
  try {
    addInstrument(item)
    showToast('已加入自选，下次无需再次搜索')
  } catch {
    showToast('本地保存失败，请检查存储空间')
  }
}
/** 详情从稳定ID恢复身份，保留整行点击热区。 */
function detail(id: string) {
  if (removing.value || Date.now() < suppressClickUntil) return
  uni.navigateTo({ url: `/pages/detail/index?id=${encodeURIComponent(id)}` })
}
/** 长按只展示当前标的的管理操作，不直接删除或同时打开详情。 */
async function remove(item: Instrument): Promise<void> {
  if (removing.value) return
  removing.value = true
  pressed.value = ''
  try {
    const confirmed = await dialog.confirm({
      title: '移除自选？',
      detail: `${item.name} · ${item.code}`,
      confirmText: '移除',
      destructive: true,
    })
    if (!confirmed) return
    removeInstrument(item.id)
    showToast('已移除自选')
  } catch {
    showToast('移除失败，请重试')
  } finally {
    removing.value = false
    suppressClickUntil = Date.now() + 350
  }
}
/** 来源前值仅用于行情涨跌显示，不作为账户收益。 */
function change(id: string): number | undefined {
  const quote = watchState.cache[id]?.quote
  return quote?.previous ? (Number(quote.value) / Number(quote.previous) - 1) * 100 : undefined
}
/** 价格保留来源的小数精度，未取得报价时不以零代替。 */
function quote(id: string): string {
  return watchState.cache[id]?.quote.value || '—'
}
</script>
<template>
  <view class="screen">
    <view class="page-head"
      ><view class="page-title">我的自选</view
      ><button class="circle-btn" aria-label="搜索并添加自选" @click="searching = true">
        <AppIcon name="plus" /></button
    ></view>
    <view class="chips"
      ><button
        v-for="label in ['全部', 'ETF', '股票', '场外基金', '积存金']"
        :key="label"
        :class="{ active: filter === label }"
        @click="filter = label"
      >
        {{ label }}
      </button></view
    >
    <view class="watch-head"
      ><text>名称 / 代码</text><text>最新价 / 净值</text><text>涨跌幅</text></view
    >
    <view class="watch-box">
      <view v-if="!visible.length" class="empty"
        ><view class="empty-title">{{
          filter === '积存金' ? '还没有关注黄金账户' : '还没有关注的标的'
        }}</view
        ><view>{{ filter === '积存金' ? '添加招行黄金账户' : '添加关注的投资标的' }}</view></view
      >
      <view
        v-for="item in visible"
        :key="item.id"
        class="watch-item"
        :class="{ 'watch-row-hover': pressed === item.id }"
        @touchstart="pressed = item.id"
        @touchend="pressed = ''"
        @touchcancel="pressed = ''"
        @touchmove="pressed = ''"
        @mousedown="pressed = item.id"
        @mouseup="pressed = ''"
        @mouseleave="pressed = ''"
        @contextmenu.prevent
      >
        <button
          class="watch-row"
          hover-class="none"
          @click="detail(item.id)"
          @longpress="remove(item)"
        >
          <view
            ><text class="asset-name">{{ item.name }}</text
            ><view class="position-code"
              >{{ item.code }} · {{ instrumentLabel(item)
              }}{{ item.type === 'STOCK' ? ' · ' + currencyOf(item) : '' }}</view
            ></view
          ><view
            ><text class="num">{{ quote(item.id) }}</text
            ><view v-if="watchState.cache[item.id]?.quote.delayed" class="position-code">延迟</view
            ><view class="position-code">{{
              watchState.loading[item.id]
                ? '更新中'
                : watchState.cache[item.id]?.quote.date.slice(5, 16) || '等待行情'
            }}</view></view
          ><view
            ><text
              class="num"
              :class="change(item.id) !== undefined ? (change(item.id)! >= 0 ? 'up' : 'down') : ''"
              >{{
                change(item.id) === undefined
                  ? '—'
                  : `${change(item.id)! >= 0 ? '+' : ''}${change(item.id)!.toFixed(2)}%`
              }}</text
            ><view class="spark"
              ><HistoryChart
                v-if="watchState.cache[item.id]?.history.points.length"
                mini
                :active="chartVisible"
                :points="watchState.cache[item.id].history.points.slice(-20)" /></view
          ></view>
        </button>
        <view v-if="watchState.errors[item.id]" class="error" style="padding: 0 12px 12px"
          >{{ watchState.errors[item.id]
          }}{{ watchState.cache[item.id] ? ' · 当前显示上次缓存' : '' }}</view
        >
      </view>
    </view>
    <button class="add-watch" @click="searching = true">＋ 添加自选标的</button>
    <view class="row tip"><button class="text-btn blue" @click="refreshAll">刷新 ↻</button></view>
    <AppToast />
    <BottomSheet v-model="searching" title="添加自选" height="82%" tab-page>
      <SearchField v-model="query" :busy="busy" :focus="searching" @search="search" />
      <view class="filters">
        <button :class="{ active: type === 'ETF' }" @click="setType('ETF')">场内 ETF</button>
        <button :class="{ active: type === 'FUND' }" @click="setType('FUND')">场外基金</button>
        <button :class="{ active: type === 'STOCK' }" @click="setType('STOCK')">股票</button>
      </view>
      <view class="search-result"
        ><view
          ><view class="asset-name">招行黄金账户</view
          ><view class="position-code">客户双侧报价 · 克 / 元换算</view></view
        ><button
          class="small-action"
          :disabled="watchState.items.some((i) => i.type === 'GOLD')"
          @click="
            add({ id: 'GOLD:CMB-GOLD', code: 'CMB-GOLD', name: '招行黄金账户', type: 'GOLD' })
          "
        >
          {{ watchState.items.some((i) => i.type === 'GOLD') ? '已添加' : '＋ 自选' }}
        </button></view
      >
      <view v-if="error" class="error">{{ error }}</view>
      <view v-for="item in results" :key="item.id" class="search-result"
        ><view
          ><view class="asset-name">{{ item.name }}</view
          ><view class="position-code"
            >{{ item.code }} · {{ instrumentLabel(item)
            }}{{ item.type === 'STOCK' ? ' · ' + currencyOf(item) : '' }}</view
          ></view
        ><button
          class="small-action"
          :disabled="watchState.items.some((row) => row.id === item.id)"
          @click="add(item)"
        >
          {{ watchState.items.some((row) => row.id === item.id) ? '已添加' : '＋ 自选' }}
        </button></view
      >
      <view v-if="searched && !busy && !error && !results.length" class="empty"
        >没有匹配的标的，可试试完整代码。</view
      >
    </BottomSheet>
    <PageOverlays />
  </view>
</template>
