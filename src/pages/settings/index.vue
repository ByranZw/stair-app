<script setup lang="ts">
import PageOverlays from '../../components/PageOverlays.vue'
import { usePageSelection } from '../../composables/useSelection'
usePageSelection(true)
import { usePageDialog } from '../../composables/useDialog'
import { usePageSheetBack } from '../../composables/useSheetBack'
usePageSheetBack()
usePageDialog(true)
import { ref } from 'vue'
import { diagnoseGold } from '../../services/market'
import BottomSheet from '../../components/BottomSheet.vue'
import DataMaintenance from '../../components/DataMaintenance.vue'
import BookActions from '../../components/BookActions.vue'
import AppToast from '../../components/AppToast.vue'
import BackupPanel from '../../components/BackupPanel.vue'
import { bookState } from '../../state/book'
const maintenance = ref<InstanceType<typeof DataMaintenance>>()
const actions = ref<InstanceType<typeof BookActions>>()
const sheet = ref(false),
  section = ref(''),
  busy = ref(false),
  diagnostic = ref<Awaited<ReturnType<typeof diagnoseGold>>>(),
  error = ref('')
/** 设置入口使用与Demo一致的抽屉，不把待开发操作伪装成功。 */
function open(name: string) {
  section.value = name
  sheet.value = true
}
/** 按已核对的黄金账户映射展示客户双侧价，不读取银行账户。 */
async function checkGold() {
  busy.value = true
  error.value = ''
  diagnostic.value = undefined
  try {
    diagnostic.value = await diagnoseGold()
  } catch (e) {
    error.value = e instanceof Error ? e.message : '接口检查失败'
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <view class="screen"
    ><view class="page-head"><view class="page-title">我的</view></view
    ><view class="card row" style="justify-content: flex-start; gap: 15px; padding: 22px 18px"
      ><view class="avatar">拾</view
      ><view style="font-size: 17px; font-weight: 700">我的投资账本</view></view
    >
    <view class="card"
      ><button class="setting-row" @click="actions?.open('accounts')">
        <text>我的账户</text
        ><text class="muted">{{ bookState.data.accounts.length }} 个账户 ›</text></button
      ><button class="setting-row" @click="open('默认投资策略')">
        <text>默认投资策略</text><text class="muted">4% 定投 ›</text></button
      ><button class="setting-row" @click="actions?.open('records', '', 'buy', '', '', '')">
        <text>全部交易记录</text
        ><text class="muted">{{ bookState.data.trades.length }} 笔记录 ›</text>
      </button></view
    >
    <view class="card"
      ><button class="setting-row" @click="maintenance?.open()">
        <text>数据管理</text><text class="muted">初始持仓 / 资金流水 ›</text></button
      ><button class="setting-row" @click="open('数据备份')">
        <text>数据备份与恢复</text><text class="muted">本地文件 ›</text></button
      ><button class="setting-row" @click="open('行情与数据来源')">
        <text>行情与数据来源</text><text class="muted">免费来源 ›</text>
      </button></view
    >
    <view class="version-note">拾阶 STAIR · 0.1.13</view>
    <BookActions ref="actions" tab-page /><DataMaintenance ref="maintenance" tab-page /><AppToast />
    <BottomSheet v-model="sheet" :title="section" tab-page :contained="section === '数据备份'">
      <template v-if="section === '默认投资策略'"
        ><view class="metric-grid"
          ><view
            v-for="rule in [
              ['资金份数', '10 份'],
              ['下跌加仓', '4%'],
              ['止盈观察', '15%'],
              ['高点回撤', '4%'],
            ]"
            :key="rule[0]"
            ><view class="metric-label">{{ rule[0] }}</view
            ><text class="metric-value">{{ rule[1] }}</text></view
          ></view
        ><view class="tip" style="margin-top: 20px">一次跌穿多档，加仓一份。</view></template
      >
      <template v-else-if="section === '行情与数据来源'"
        ><view class="setting-row"
          ><text>ETF / 股票行情与历史</text><text class="blue">腾讯财经</text></view
        ><view class="setting-row"
          ><text>基金检索 / 正式净值</text><text class="blue">东方财富</text></view
        ><view class="setting-row"
          ><text>积存金双侧报价</text><text class="gold">招行黄金账户</text></view
        ><view class="setting-row"
          ><text>黄金市场参考走势</text><text class="gold">上金所 Au99.99</text></view
        ><view class="tip">基金取正式净值；黄金市场走势与招行成交报价分别展示。</view
        ><button class="secondary full" :disabled="busy" @click="checkGold">
          {{ busy ? '检查中…' : '检查最新双侧报价' }}</button
        ><view v-if="diagnostic" class="tip"
          ><view>客户买入价（元/克）：{{ diagnostic.buyField }}</view
          ><view>客户卖出价（元/克）：{{ diagnostic.sellField }}</view
          ><view>来源时间：{{ diagnostic.time }}</view></view
        ><view v-if="error" class="error">{{ error }}</view></template
      >
      <BackupPanel v-else-if="section === '数据备份'" />
    </BottomSheet>
    <PageOverlays />
  </view>
</template>
