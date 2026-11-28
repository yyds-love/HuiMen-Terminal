# 自动更新与发布

XuYa Terminal 使用 Tauri v2 的签名验证更新。Windows / macOS 可在应用内下载安装；Linux 提示前往公开更新仓库的 GitHub Release 手动下载。朋友运行安装包不需要 Node.js、pnpm、Rust 或编译工具；Windows 首次安装 WebView2 时可能需要联网。

## 首次发布配置

源码可以保留在私有仓库，应用更新使用单独的公开仓库。当前约定的源码仓库为 `yyds-love/HuiMen-Terminal`，公开更新仓库为 `yyds-love/HuiMen-Terminal-Updates`。公开更新仓库只保存签名安装包、对应 `.sig` 和 `latest.json`，朋友无需加入源码仓库即可下载。

首次配置时，按以下步骤操作：

1. 在 GitHub 创建公开仓库 `HuiMen-Terminal-Updates`，初始化 `main` 分支，例如添加 README。不要把源码放入这个仓库。

2. 为该公开更新仓库创建一个 Fine-grained personal access token，仅授权该仓库的 `Contents: Read and write`。在私有源码仓库的 `Settings → Secrets and variables → Actions` 添加 `UPDATE_REPO_TOKEN`。该令牌只用于 CI 发布，不会进入客户端。

3. 在仓库外的安全位置生成一套更新签名密钥，并设置密码：

   ```powershell
   pnpm tauri signer generate --write-keys <仓库外路径>/updater.key
   ```

   长期备份私钥及密码。私钥和密码不能提交到 Git、放进安装包或发给他人。公钥文件 `updater.key.pub` 可以公开。

4. 仅使用生成的 `.pub` **公钥文件**配置源码和更新来源：

   ```powershell
   pnpm release:configure --repository OWNER/SOURCE-REPOSITORY --updater-repository OWNER/UPDATES-REPOSITORY --public-key <仓库外路径>/updater.key.pub
   pnpm release:check
   ```

   `--repository` 填写私有源码仓库，`--updater-repository` 填写公开更新仓库。命令会将包源码地址与应用更新地址分别写入配置，不改变版本号或 Git 远程。

5. 在私有源码仓库的 `Settings → Secrets and variables → Actions` 添加：
   - `TAURI_SIGNING_PRIVATE_KEY`：生成的私钥文件完整内容，包含整个 base64 字符串。
   - `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`：生成密钥时设置的密码。

不要只复制解码后私钥的第二行。构建时由 Tauri 签名；客户端始终校验签名。格式预检不能代替验证私钥、公钥和密码是否匹配。

**首次给朋友分发前固定公开更新仓库、公钥和应用标识。** 修改公钥后，旧客户端不能验证新密钥签出的更新。旧版客户端如果内置了私有源码仓库的更新地址，必须先手动安装一次新版，之后才能从公开更新仓库自动更新。仓库迁移和密钥轮换需要单独设计兼容升级。

## 发布新版本

1. 使用 `pnpm version:set 1.0.11` 同步版本号，再运行 `pnpm release:check`、`pnpm check-types`、`pnpm test`、`pnpm test:release`、`pnpm build` 和 `cargo test --locked`。示例中的版本号应替换为下一个补丁版本。
2. 提交代码并推送到私有源码仓库，创建匹配版本的 tag，例如 `git tag v1.0.11`，再推送该 tag。当前流程只支持正式版 `MAJOR.MINOR.PATCH`。
3. Actions 检查版本、源码仓库、公开更新仓库、公钥、签名密钥和测试，再构建各平台安装包并生成 updater 清单。源仓库中的草稿用于暂存，所有平台构建成功后，发布任务会把签名文件和安装包复制到公开更新仓库，并发布该版本。
4. 确认公开更新仓库中的安装包、对应 `.sig` 和 `latest.json` 齐全，清单版本、平台、公开下载地址和签名一致。先在可恢复的测试环境验收全新安装和从上一版升级。客户端只请求公开更新仓库，不访问私有源码仓库。

Windows 更新优先使用 NSIS；Windows Authenticode / macOS 代码签名与 updater 签名是不同机制。updater 签名不代表系统已信任安装包的发布者。

## 本地预览与验收范围

正式发布前可用 `pnpm tauri build --bundles nsis --no-sign` 构建 Windows 本地预览包，产物位于 `target/release/bundle/nsis/`。它不具备正式更新能力，不能作为已验收的自动更新版本分发。

真实更新链路至少用同一公钥构建两个递增版本，在测试环境验证成功更新、断网、错误签名、重复点击和安装失败恢复。不要在真实终端任务或未保存文件仍打开时执行更新。Linux/macOS 的桌面行为必须在对应系统验收；Windows 构建成功不能替代这些检查。

Windows 的 Tauri updater 启动安装器后会退出当前应用。界面能处理下载、签名校验和安装器交接前返回的错误；安装器启动后的取消或失败，需要检查安装器结果和重新启动后的应用版本，不能仅凭界面状态判定安装成功。
