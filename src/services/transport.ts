import type { Provider } from '../domain/market'
const origins: Record<Provider, string> = {
  'stock-search': 'https://smartbox.gtimg.cn',
  fx: 'https://hq.sinajs.cn',
  tencent: 'https://proxy.finance.qq.com/ifzqgtimg',
  'fund-search': 'https://fundsuggest.eastmoney.com',
  'fund-nav': 'https://api.fund.eastmoney.com',
  'fund-actions': 'https://fundf10.eastmoney.com',
  cmb: 'https://mbmodule-openapi.paas.cmbchina.com',
  sge: 'https://www.sge.com.cn',
}
/** 只有H5开发环境使用本机代理，App和H5生产包均保留真实来源地址。 */
export function providerUrl(provider: Provider, path: string): string {
  let origin = origins[provider]
  // #ifdef H5
  if (import.meta.env?.DEV) origin = `/market/${provider}`
  // #endif
  return origin + path
}
/** 只读请求不自动重试；HTTP失败与解析失败均不能冒充空行情成功。 */
export function requestText(provider: Provider, path: string, data?: string): Promise<string> {
  const header: Record<string, string> = {}
  if (data) header['Content-Type'] = 'application/x-www-form-urlencoded'
  // #ifdef APP-PLUS
  if (provider === 'fx') header.Referer = 'https://finance.sina.com.cn/'
  if (provider === 'fund-nav') header.Referer = 'https://fundf10.eastmoney.com/'
  if (provider === 'sge') header.Referer = 'https://www.sge.com.cn/sjzx/mrhq'
  // #endif
  return new Promise((resolve, reject) => {
    uni.request({
      url: providerUrl(provider, path),
      method: data ? 'POST' : 'GET',
      data,
      header,
      timeout: 10000,
      dataType: 'text',
      success: (response) => {
        if (response.statusCode !== 200) {
          reject(
            new Error(
              provider === 'sge' && response.statusCode === 403
                ? '行情源暂时限制访问，请稍后刷新'
                : `行情请求失败（HTTP ${response.statusCode}）`,
            ),
          )
          return
        }
        if (typeof response.data === 'string') resolve(response.data)
        else reject(new Error('行情来源返回了无法识别的数据'))
      },
      fail: () => reject(new Error('暂时无法连接行情来源，请稍后刷新')),
    })
  })
}
/** JSON与公告文本复用固定来源传输，解析失败不能伪装成空报价。 */
export async function requestJson(
  provider: Provider,
  path: string,
  data?: string,
): Promise<unknown> {
  const raw = await requestText(provider, path, data)
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('行情来源返回了无法识别的数据')
  }
}
