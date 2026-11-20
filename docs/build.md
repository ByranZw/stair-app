# 开发与安卓构建

## 环境与本地调试

- Node.js 22、npm。
- App 资源使用与当前依赖匹配的 HBuilderX；当前构建版本为 5.34。
- 本地原生包重建脚本另需 Python 3、Java 17、Apktool 3.0.3 和 HBuilderX 安心打包工具。

```sh
npm ci
npm run dev:h5
```

开发服务器绑定 `127.0.0.1:5178`，通过本地代理访问固定行情来源。生产 H5 按浏览器跨域规则请求，当前并非可直接静态部署的完整行情服务。

```sh
npm run typecheck
npm test
npm run build:h5
npm run build:app
```

H5 产物位于 `dist/build/h5`，App 编译资源位于 `dist/build/app`。`tests/fixtures` 是公开接口响应样本，解析测试无需联网。

## 原生打包配置

当前应用 AppID 为 `__UNI__A7ED73C`，安卓包名为 `cn.stair.invest`。开发自己的应用时，请在 DCloud 注册应用，替换 AppID、包名及相应平台配置，并使用自己的签名。

使用 HBuilderX 导入工程，选择原生 App 打包，按所选渠道配置签名及模块。工程使用 SQLite 模块。当前安卓产物为 ARM64，最低 SDK 21（Android 5.0），目标 SDK 35。

AppKey、签名私钥、密码、官方原生初包与工具链由本机提供，不包含在源码仓库中。普通云打包与安心打包的资源上传方式不同，操作时按实际渠道说明选择。

## 使用现有原生初包在本地重建

`scripts/build-android.py` 用于将当前应用资源合入同一应用的官方原生初包。它需要先取得该应用的官方初包，并使用同一签名；不能仅克隆仓库后直接执行。

先导出最新资源：

```sh
/path/to/HBuilderX/cli publish app-android \
  --type appResource \
  --project /absolute/path/to/stair-app
```

资源将导出到 `unpackage/resources/<AppID>/www`。再从项目根目录运行：

```sh
python3 scripts/build-android.py \
  --base-apk /path/to/official-base.apk \
  --apktool /path/to/apktool_3.0.3.jar \
  --pack-tools /path/to/HBuilderX/plugins/app-safe-pack \
  --signing-config /private/path/signing.local.json \
  --java /path/to/java17/bin/java \
  --output dist/release/apk/stair-0.1.8-arm64.apk
```

签名 JSON 放在仓库外，包含 `storeFile`、`alias`、`storePassword`、`keyPassword`。其中 `storeFile` 指向本机密钥库，密码由脚本通过环境变量传给签名工具。

脚本更新权限、SDK 与应用版本、图标及导出资源，并检查：

- Apktool 下载文件的固定 SHA-256。
- 官方原生 DEX、动态库未发生变化。
- APK 内资源与本次导出文件逐字节一致。
- ZIP、zipalign、APK 签名及原证书一致性。

成功后输出 APK、校验报告 JSON 和签名摘要。失败时保留已有安装包。新增原生模块或升级 DCloud 运行时后，需要重新生成官方原生初包。

## 安装与验证

使用同一包名和签名覆盖安装可保留现有应用数据。更换签名通常需要卸载，操作前先[导出账本](backup.md)。

新包需在安卓设备核对行情直连、SQLite 记账、文件备份恢复及图表交互。H5 检查和资源编译不能代替设备验证；最新 0.1.8 包已完成构建与签名校验，尚未单独完成本轮设备安装验证。

iOS 尚未完成打包和适配，当前脚本仅构建安卓包。
