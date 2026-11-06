# Passkey Recovery by sd0x

[English](README.md)

一個在你自己電腦上執行的開源工具。如果你用 Passkey 建立過 **Coinbase Smart Wallet v1.1**，而有人把資產轉到你在 **Plasma**（chainId 9745）上的同一地址，但錢包從未部署在 Plasma，這個工具會幫你部署缺少的錢包，並把你自己的資產轉到你指定的地址。每一步都由你簽署、由你送出。

> **獨立專案。** Passkey Recovery 與 Coinbase、Plasma 無任何隸屬、背書或支援關係，**尚未經過稽核**。它永遠不會要你正在救援的錢包的助記詞或私鑰。

## 適用對象

| 適用 | 不適用 |
|------|--------|
| 你仍持有 Coinbase Smart Wallet v1.1 的 Passkey | 遺失 Passkey、seed phrase 錢包 |
| 資產到了 Plasma mainnet（9745）上的那個地址 | 其他品牌或版本的 smart wallet |
| 你能用自己的錢包付一點 XPL gas | Plasma 以外的任何鏈 |

## 運作方式

1. **Check wallet**：輸入地址。若 Plasma 上尚未部署，貼上建立時的證據（owners 與 factory nonce）；工具在本機重算 CREATE2 地址，並與 `factory.getAddress` 一致才接受。
2. **Deploy wallet**：只在需要時出現。Safe Singleton Factory 與 EntryPoint v0.6 必須已在 Plasma 的標準地址上，缺少或不一致時工具會停止。工具只部署缺少的 Coinbase Smart Wallet v1.1 implementation、factory，最後是你的錢包：每一項是一筆獨立交易，先以 synthetic sender 在 fork 上預覽，由你以「**部署第 N 步**」確認、gas 錢包付費；已存在的步驟自動跳過。
3. **Move funds**：選資產、金額、收款地址 → 預覽 → 用 Passkey 簽 UserOperation hash → 在本機 Anvil fork 上檢查**已簽模擬** → 按下 **Send**。
4. **Track**：追蹤到 receipt；重新整理或 runner 重啟後仍可追蹤，永不自動重送。

Passkey 只能替它所屬的網站簽署，所以簽署發生在 Coinbase 自己的頁面（`keys.coinbase.com`）。主要方式是拖到書籤列的 **bookmarklet**；瀏覽器擋 bookmarklet 時，另有進階的 **DevTools fallback**。兩者都只接受本工具產生的一次性代碼，也只在 Coinbase 的 origin 上執行。

### Gas 錢包模式

你要救的錢包是「Passkey source account」，另由一個 **gas 錢包**付手續費：

| Gas 錢包 | 金鑰在哪裡 | 哪裡可用 |
|----------|-----------|----------|
| 瀏覽器錢包（EIP-6963，例如 OKX） | 錢包本身 | 網站與本機 runner |
| 瀏覽器內 File：產生或開啟加密 keystore（v3，scrypt，密碼 ≥ 12 字） | 只在這個分頁的記憶體；離開模式即清除 | 網站與本機 runner |
| File（native）或 1Password（你自己的 `op` CLI、單一 Private Link item） | 你電腦上 runner 的 signer 子程序記憶體 | 本機 runner，或與本機 runner 配對後的網站 |
| 既有 gas 錢包：你電腦上已有的加密 keystore，密碼在 1Password | runner 的 signer 子程序記憶體。用 manifest 或 1Password 路徑欄位時由 signer 自己讀檔；用「選擇檔案」時，頁面讀取加密的 keystore 文字，經 `127.0.0.1` 只送給你的本機 signer（從網站使用時需先配對）。它不會上傳到網站或任何遠端服務，signer 也不在磁碟留副本 | 本機 runner，或與本機 runner 配對後的網站 |

## 安裝與執行

需要 Node.js **24.22.1** 與 npm **11.19.1**。完整步驟見 [docs/INSTALL.zh-TW.md](docs/INSTALL.zh-TW.md)。

repository 與它的 Release 都還沒有發布。從你已有的原始碼資料夾：

```bash
npm ci
npm run build
npm run runner                 # 工具在 http://127.0.0.1:4171/recover（只有這台電腦）
# 或一步完成：npm run preview   （先 build，再以 4171 啟動 runner）
```

打包成一個套件檔（未上 npm registry）：

```bash
npm pack                                        # 產生 passkey-recovery-0.2.0.tgz
shasum -a 256 passkey-recovery-0.2.0.tgz        # 記下你執行的是哪個檔案
npm exec --yes --package ./passkey-recovery-0.2.0.tgz -- passkey-recovery
```

發布之後（規劃中），同一個檔案與它的 sha256 會放在 GitHub Release；見 [docs/INSTALL.zh-TW.md](docs/INSTALL.zh-TW.md) §2c。

Runner 只綁 `127.0.0.1`，第一次需要模擬時才啟動 sha256 釘選的 Anvil（npm optional dependency）。`Ctrl-C` 會結束它與它啟動的每個程序。要讓網站與你的 runner 配對，以 `--allow-origin https://<網站>` 啟動，並輸入它印出的代碼。沒有 runner 時，網站只提供指南與 bookmarklet：檢查錢包、模擬與送出都需要已配對的 runner，不會改用任何雲端服務。

## 安全模型摘要

- 永遠不會要求你救援的錢包的金鑰。Gas 錢包的秘密只在分頁記憶體或 runner 隔離的 signer 子程序裡，不進 log、storage、URL 或命令列參數。
- 沒有你的確認就不會送出任何東西：每個部署步驟按「**部署第 N 步**」，轉帳按 **Send**。部署步驟先以 synthetic sender 在 fork 上模擬；轉帳依簽好的內容原樣模擬。
- 你的 RPC key 只留在記憶體；預設使用公開的 Plasma RPC。檢查與模擬只從目前的 RPC 讀取；你確認後的交易由你的瀏覽器錢包廣播；若由這個分頁裡的 gas 金鑰或 runner 的 native signer 簽署，則由 runner 經目前的 RPC 廣播。
- AI 助手只能讀遮罩過的報告，永遠不能簽署。

細節見 [SECURITY.md](SECURITY.md) 與 [安全與架構](docs/features/open-source-recovery/3-architecture.md)。與 AI 助手協作：[docs/AI_COLLABORATION.md](docs/AI_COLLABORATION.md)。

## 狀態

版本 0.2.0。這個工具自動化的方法曾救回 Plasma 上一個真實的 Coinbase Smart Wallet v1.1；工具本身已用 runner 的「既有 gas 錢包（keystore＋1Password）」模式完成並核對一筆 mainnet 轉帳；其他 gas 模式只在 synthetic 測試鏈上測試過。尚未經過稽核。本機或 fork 模擬不等於 mainnet：只有你送出、且 **Track** 顯示 `confirmed` 或 `final` 的交易才代表鏈上狀態。

## 開發

| 命令 | 內容 | 連網 |
|------|------|------|
| `npm run typecheck` | TypeScript | 否 |
| `npm run test` | Unit tests | 否 |
| `npm run test:integration` | Synthetic Anvil 測試鏈（chainId 9745） | 只連 127.0.0.1 |
| `npm run test:e2e` | Playwright＋axe，對本機 build（第一次：`npx playwright install chromium`） | 只連 127.0.0.1 |
| `npm run test:live` | 對 `https://rpc.plasma.to` 的唯讀查詢 | 是（唯讀） |
| `npm run build`／`npm run build:hosted` | Runner 套件 build／靜態網站（`dist-hosted/`） | 否 |
| `npm run release:licenses`、`release:scan`、`release:rebuild-contracts` | 授權檢查、秘密與隱私掃描、合約重建 | 只有重建需要 |

貢獻：[CONTRIBUTING.md](CONTRIBUTING.md)・行為準則：[CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)・設計文件：[docs/features/open-source-recovery/](docs/features/open-source-recovery/2-tech-spec.md)。

## 授權

[Apache-2.0](LICENSE)，另見 [NOTICE](NOTICE) 與 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。內含的合約 bytecode 來自上游專案，依各自授權（GPL-3.0、LGPL-3.0、MIT）；來源與重建方式見 [registry/coinbase-smart-wallet-v1.1/SOURCE.md](registry/coinbase-smart-wallet-v1.1/SOURCE.md)。
