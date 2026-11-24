# 自动更新与发布

XuYa Terminal 使用 Tauri v2 的签名验证更新。Windows / macOS 可在应用内下载安装；Linux 提示前往自己的 GitHub Release 手动下载。朋友运行安装包不需要 Node.js、pnpm、Rust 或编译工具；Windows 首次安装 WebView2 时可能需要联网。

## 首次发布配置

当前发布来源为 [`yyds-love/HuiMen-Terminal`](https://github.com/yyds-love/HuiMen-Terminal)，更新签名公钥已配置。首次发布前仍需设置下述 Actions Secrets 并完成安装、升级验收；保留 `.github/workflows/release.yml`。

首次配置或为自己的仓库重新配置时，按以下步骤操作：

1. 在仓库外的安全位置生成一套更新签名密钥，并设置密码：

   ```powershell
   pnpm tauri signer generate --write-keys <仓库外路径>/updater.key
   ```

   长期备份私钥及密码。私钥和密码不能提交到 Git、放进安装包或发给他人。公钥文件 `updater.key.pub` 可以公开。

2. 仅使用生成的 `.pub` **公钥文件**配置发布来源：

   ```powershell
   pnpm release:configure --repository OWNER/REPOSITORY --public-key <仓库外路径>/updater.key.pub
   pnpm release:check
   ```

   命令同步 `package.json` 与 Tauri 的仓库地址、公钥和签名产物开关，不改变版本号或 Git 远程。更新地址为 `https://github.com/OWNER/REPOSITORY/releases/latest/download/latest.json`。

3. 在 GitHub 的 `Settings → Secrets and variables → Actions` 添加：
   - `TAURI_SIGNING_PRIVATE_KEY`：生成的私钥文件完整内容，包含整个 base64 字符串。
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时设置的密码。

不要只复制解码后私钥的第二行。构建时由 Tauri 签名；客户端始终校验签名。格式预检不能代替验证私钥、公钥和密码是否匹配。

**首次给朋友分发前固定仓库、公钥和应用标识。** 修改公钥后，旧客户端不能验证新密钥签出的更新。已分发的未配置预览包需要手动安装首次正式版，之后才能自动更新。仓库迁移和密钥轮换需要单独设计兼容升级。

## 发布新版本

1. 使用 `pnpm version:set 1.0.8` 同步版本号，再运行 `pnpm release:check`、`pnpm check-types`、`pnpm test`、`pnpm test:release`、`pnpm build` 和 `cargo test --locked`。
2. 提交代码并推送到自己的仓库，创建匹配版本的 tag，例如 `git tag v1.0.8`，再推送该 tag。当前流程只支持正式版 `MAJOR.MINOR.PATCH`。
3. Actions 先检查版本、仓库、公钥、签名产物及测试，再构建 Windows、macOS、Linux 安装包，上传到 **Draft Release（草稿）**。构建失败时不要发布草稿。
4. 等所有平台任务成功，确认安装包、对应 `.sig` 和 `latest.json` 齐全，且清单版本、平台、下载地址和签名对应。先在可恢复的测试环境验收全新安装、从上一版升级、卸载和旧版客户端更新，再手动发布草稿。公开正式 Release 后，客户端才能发现它。

Windows 更新优先使用 NSIS；Windows Authenticode / macOS 代码签名与 updater 签名是不同机制。updater 签名不代表系统已信任安装包的发布者。

## 本地预览与验收范围

未配置发布来源时可用 `pnpm tauri build --bundles nsis --no-sign` 构建 Windows 本地预览包，产物位于 `target/release/bundle/nsis/`。它不具备正式更新能力，不能作为已验收的自动更新版本分发。

真实更新链路至少用同一公钥构建两个递增版本，在测试环境验证成功更新、断网、错误签名、重复点击和安装失败恢复。不要在真实终端任务或未保存文件仍打开时执行更新。Linux/macOS 的桌面行为必须在对应系统验收；Windows 构建成功不能替代这些检查。

Windows 的 Tauri updater 启动安装器后会退出当前应用。界面能处理下载、签名校验和安装器交接前返回的错误；安装器启动后的取消或失败，需要检查安装器结果和重新启动后的应用版本，不能仅凭界面状态判定安装成功。
