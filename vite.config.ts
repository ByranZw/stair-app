import { defineConfig } from 'vite'
import uni from '@dcloudio/vite-plugin-uni'

/** 代理严格绑定公开来源及路径，不提供任意URL转发；仅开发服务器使用。 */
export default defineConfig({
  plugins: [uni()],
  server: {
    host: '127.0.0.1',
    port: 5178,
    strictPort: true,
    proxy: {
      '^/market/sge/graph/(?:Dailyhq|quotations)$': {
        target: 'https://www.sge.com.cn',
        changeOrigin: true,
        headers: { Referer: 'https://www.sge.com.cn/sjzx/mrhq' },
        rewrite: (path) => path.replace('/market/sge', ''),
      },
      '^/market/fund-actions/fhsp_[0-9]{6}\\.html$': {
        target: 'https://fundf10.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace('/market/fund-actions', ''),
      },
      '^/market/tencent/appstock/app/fqkline/get(?:\\?|$)': {
        target: 'https://proxy.finance.qq.com',
        changeOrigin: true,
        rewrite: (path) => path.replace('/market/tencent', '/ifzqgtimg'),
      },
      '^/market/tencent/appstock/app/minute/query(?:\\?|$)': {
        target: 'https://proxy.finance.qq.com',
        changeOrigin: true,
        rewrite: (path) => path.replace('/market/tencent', '/ifzqgtimg'),
      },
      '^/market/fund-search/FundSearch/api/FundSearchAPI.ashx(?:\\?|$)': {
        target: 'https://fundsuggest.eastmoney.com',
        changeOrigin: true,
        rewrite: (path) => path.replace('/market/fund-search', ''),
      },
      '^/market/fund-nav/f10/lsjz(?:\\?|$)': {
        target: 'https://api.fund.eastmoney.com',
        changeOrigin: true,
        headers: { Referer: 'https://fundf10.eastmoney.com/' },
        rewrite: (path) => path.replace('/market/fund-nav', ''),
      },
      '^/market/cmb/product/v1/func/market-center(?:\\?|$)': {
        target: 'https://mbmodule-openapi.paas.cmbchina.com',
        changeOrigin: true,
        rewrite: (path) => path.replace('/market/cmb', ''),
      },
    },
  },
})
