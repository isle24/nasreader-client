# nasReader 桌面客户端

Tauri 2 原生客户端，使用与 Web 相同的 Vue 前端。首次打开输入自己的 NAS 服务地址，再登录 nasReader 账号；本仓库不包含服务端，也不附带账号、书籍、书源、数据库或 NAS 配置。

## 构建与产物

先安装 Node.js 24、Rust stable 和目标系统的 Tauri 2 开发依赖：

```sh
npm --prefix front-end ci
npm --prefix client ci
npm --prefix front-end run build
```

在目标系统运行对应命令：

```sh
npm --prefix client run build:windows
npm --prefix client run build:mac
npm --prefix client run build:linux
```

GitHub Actions 自动构建 Windows x64、Mac ARM64/Intel、Linux x64/ARM64，每个产物包含 SHA256SUMS.txt 与 BUILD-INFO.json。Windows 提供安装 EXE/MSI 和便携 ZIP；Mac 提供 DMG 和 APP ZIP；Linux 提供 DEB/RPM/AppImage。产物位于 client/src-tauri/target/<target>/release/bundle/。

Windows 便携版需要 Microsoft Edge WebView2 Runtime，安装版可安装缺失的 Runtime。Windows 包未购买代码签名证书；Mac 使用 adhoc 签名，未进行 Apple 公证。Linux 客户端依赖兼容的 GTK3/WebKit2GTK 4.1 与桌面 Secret Service；AppImage 也受宿主 glibc 和图形环境限制，不能保证所有银河麒麟版本兼容。银河麒麟使用与其 CPU 架构相符的 Linux 包，仍需真机验收。

登录会话按规范化服务端地址隔离，Windows 使用系统凭据管理器，Mac 使用 Keychain，Linux 使用用户桌面 Secret Service。离线书籍按服务端和用户隔离。本地打包页面拥有原生权限，远端页面不授予原生权限。

GitHub 构建仓库通过白名单导出客户端及生产前端；EXPORT-MANIFEST.json 记录每个文件与原始提交，构建前逐文件核验。服务端、Docker、NAS 数据、私有日志及原仓库历史均不导出。后续构建可在 Actions → Desktop packages → Run workflow 手动触发。

依赖许可见 LICENSE 和 THIRD_PARTY_NOTICES.md。应用图标由本项目的 client/assets/icon.svg 生成。
