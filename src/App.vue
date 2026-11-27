<script setup lang="ts">
import { onShow, onHide } from '@dcloudio/uni-app'
import { appVisible } from './state/app-visibility'
import { refreshAll } from './state/watchlist'
import { initializeBook } from './state/book'
import { appUpdater } from './state/app-update'
/** 启动与返回前台统一刷新；同标的请求合并，来源失败不清空缓存。 */
onShow(() => {
  appVisible.value = true
  void appUpdater.check()
  void initializeBook()
    .then(refreshAll)
    .catch(() => undefined)
})
// 切后台时先停详情采样，已发出的请求仍由行情层安全归档。
onHide(() => {
  appVisible.value = false
})
</script>
<style lang="scss">
@import './styles.scss';
</style>
