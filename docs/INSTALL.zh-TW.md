# 安裝與執行

[English](INSTALL.md)

Passkey Recovery 在兩個地方執行，介面相同：

| | 網站 | 本機 runner |
|-|------|-------------|
| 是什麼 | 透過 https 提供的靜態頁面 | 你電腦上的小程式，UI 在 `http://127.0.0.1:4171/` |
| 指南、bookmarklet | 可以 | 可以 |
| 檢查錢包、模擬與送出 | 只有在與你的本機 runner 配對時 | 可以 |
| Gas 錢包：瀏覽器錢包、瀏覽器內 File | 可以 | 可以 |
| Gas 錢包：File（native）、1Password、既有 gas 錢包 | 只有在與你的本機 runner 配對時（私鑰留在它的 signer） | 可以 |

目前的狀態：原始碼已公開在 [GitHub](https://github.com/sd0xdev/passkey-recovery)；目前沒有可下載的 GitHub Release 或 tarball；網站已上線於 [passkey-recovery.sd0x.dev](https://passkey-recovery.sd0x.dev)，只提供靜態頁面。無論如何，工具都需要本機 runner，從 clone 建置（§2a）。

## 1. 需求

- macOS（arm64 或 x64）、Linux（x64 或 arm64），或 Windows（只支援 x64；Windows arm64 沒有釘選的 Anvil build）。
- Git、Node.js **24.22.1** 與 npm **11.19.1**。安裝方式在 §2a 第 2 步。
- 有你 Coinbase Smart Wallet Passkey 的 Chromium 系瀏覽器或 Safari。
- 一個你自己控制、在 Plasma 上有少量 XPL 的錢包，用來付 gas。

模擬用的本機鏈 Anvil 會隨套件安裝：依平台釘選版本、檢查 sha256 的 npm optional dependency。要改用你自己的 build，設定 `CBPR_ANVIL=<anvil 路徑>`。

## 2a. 從原始碼執行

1. 取得原始碼：

   ```bash
   git clone https://github.com/sd0xdev/passkey-recovery.git
   cd passkey-recovery
   ```

2. 在那個資料夾使用釘選的工具。`nvm install 24.22.1` 會安裝並選用 Node.js；`fnm use` 從 `.nvmrc` 讀取同一個版本。用 `npm -v` 檢查 npm；如果比 11.19.1 舊，請執行 `npm install -g npm@11.19.1`。`npm ci` 會拒絕這個範圍以外的版本（`package.json` 的 `engines`）。
3. 安裝 pinned 相依套件並建置：

   ```bash
   npm ci
   npm run build
   ```

4. 啟動 runner（`npm run preview` 會一次完成 build 與這一步）：

   ```bash
   npm run runner
   ```

5. 開啟它印出的網址 `http://127.0.0.1:4171/recover`。那個頁面就是工具本身，不需要配對。

## 2b. 或打包成一個套件檔執行

完成 §2a 第 3 步後，同一個資料夾可以把同一個 runner 打包成一個檔案。這個檔案是你自己做的，不是已發布的 Release。

1. 打包：

   ```bash
   npm pack            # 產生 passkey-recovery-<version>.tgz
   ```

2. 記下它的 SHA-256，之後就能分辨你執行的是哪個檔案：`shasum -a 256 passkey-recovery-<version>.tgz`（Windows：`certutil -hashfile <檔案> SHA256`）。
3. 用那個檔案啟動 runner（也可以先複製到一個空資料夾）：

   ```bash
   npm exec --yes --package ./passkey-recovery-<version>.tgz -- passkey-recovery
   ```

4. 開啟它印出的網址。那是同一個工具。

這個套件沒有上 npm registry；`npm exec` 只會從檔案安裝到 npm 的 cache。

## 2c. GitHub Release（規劃中，尚未發布）

目前沒有 tag、GitHub Release 或 tarball，所以沒有東西可以下載。發布之後，規劃的方式是：從 [releases 頁面](https://github.com/sd0xdev/passkey-recovery/releases) 下載 `passkey-recovery-<version>.tgz`，與那裡公布的 sha256 比對，再執行 §2b 的同一個 `npm exec` 指令。

## 3. Runner 選項

| 選項 | 意義 |
|------|------|
| `--port <n>` | UI port（預設 4171）；native signer 用下一個 port，除非另給 `--signer-port` |
| `--allow-origin https://<網站>` | 允許與此 runner 配對的網站（完整 https origin；可重複） |
| `--no-native-signer` | 不啟動 native signer（File native、1Password、既有 gas 錢包模式關閉） |
| `--gas-manifest <絕對路徑>` | 既有 gas 錢包的 public manifest（預設 `~/.local/share/passkey-recovery/gas-wallet-public.json`） |
| `--help`、`--version` | 顯示說明或版本 |

執行中：`p` 產生新的配對代碼，`u` 結束所有配對，`q` 或 `Ctrl-C` 結束 runner 與它啟動的每個程序。

## 4. 讓網站與你的 runner 配對

1. 以網站的完整 origin 啟動 runner。官方網站從原始碼啟動的命令是：`npm run runner -- --allow-origin https://passkey-recovery.sd0x.dev`。這個版本的 runner 沒有預設允許配對的網站 origin，所以一定要加這個參數；你自己架設的網站同樣用它自己的 origin。網站的 Download 頁面會顯示完整命令。
2. 在網站開啟 **Recover**，按 **連接 runner**（英文介面為 Connect runner），輸入終端機顯示的 `XXXX-XXXX` 代碼。
3. 配對只存在該分頁；閒置 30 分鐘、重新整理或 runner 結束時即失效。

## 5. 1Password gas 錢包（本機 runner）

Runner 呼叫你自己的 `op` CLI，`op` 只透過 1Password 桌面 App 登入，每次請求由你在 App 裡核准。不使用 service account token、`op signin` session 或 Connect。

1. 在 1Password App：**Settings → Developer → Integrate with 1Password CLI**，並保持 App 執行。
2. macOS 另到 **系統設定 → 隱私權與安全性 → 檔案與資料夾 → Data shared by 1Password**，允許啟動 runner 的 App（例如「終端機」）。
3. Private Link 請原樣貼上；帳號 ID 區分大小寫。

頁面顯示 CLI 連不到 App 時，先檢查這兩項設定，再重新啟動 1Password App 與終端機。

## 6. 疑難排解

| 訊息 | 處理方式 |
|------|----------|
| `could not start on 127.0.0.1:… (EADDRINUSE)` 或 `signer port … is in use` | 4171 或 4172 被其他程式占用；以 `--port <空的 port>` 啟動 |
| `could not locate Anvil`／pin 不符 | 以 `npm ci` 重新安裝，或把 `CBPR_ANVIL` 指向可信的 Anvil build |
| `--allow-origin: …` | 給完整的 `https://host` origin，不要帶路徑 |
| Bookmarklet 沒反應 | 瀏覽器在該頁擋了 bookmarklet；改用指南中的 DevTools fallback |

需要協助時，按 **AI 報告**（英文介面為 AI report），只分享那段遮罩過的文字。永遠不要把金鑰、密碼、keystore 或 Passkey 資料給任何人。
