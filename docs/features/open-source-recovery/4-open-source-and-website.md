# Open-source release & website spec（規劃）

> **Doc class**: Lifecycle — Phase 4 appendix（current authority）。**現況（2026-11-07）：原始碼已公開（`github.com/sd0xdev/passkey-recovery`，CI 通過）；Runner Release 與 tarball 尚未發布；網站尚未部署。** 授權、repo 與託管已於 2026-10-31 由使用者決定（§1）；M5（2026-11-02）已在本機完成發布所需的檔案、export、掃描、CI 設定與 runner 套件；tag、Release 與部署仍是維護者步驟（[release plan](../../release/release-plan.md)、[deploy plan](../../release/deploy-plan.md)）。
> 上游：[2-tech-spec.md](./2-tech-spec.md) · 設計：[design-ui-ux-guidelines.md](./design-ui-ux-guidelines.md)

## 1. Release 現況（2026-11-02，M5 本機完成）

| 項目 | 現況 | 公開前仍需 |
|------|------|-----------|
| LICENSE | Apache-2.0 官方全文（`LICENSE`）、`NOTICE`、`package.json` `license` | — |
| 依賴授權 | [`THIRD_PARTY_NOTICES.md`](../../../THIRD_PARTY_NOTICES.md)；`scripts/release/licenses.mjs --check` 檢查隨套件出貨的 npm 依賴（含 transitive）與允許清單，產生 `licenses/npm-shipped.txt` | — |
| 合約 bytecode | 每份 bytecode 追到上游 commit 與 solc 設定；`scripts/release/rebuild-contracts.mjs` 從原始碼重建比對（[SOURCE.md](../../../registry/coinbase-smart-wallet-v1.1/SOURCE.md)）；GPL／LGPL 原始碼與授權文字隨附於 `licenses/` | — |
| 字型 | Atkinson Hyperlegible Next／Mono（SIL OFL 1.1），授權文字在 `licenses/`，build 時一併輸出 | — |
| Repo 與官網 | `github.com/sd0xdev/passkey-recovery`；`wrangler.jsonc`（Workers Static Assets、workers.dev、wrangler 釘選）；dry-run 不上傳 | 維護者部署並 read-back（repo 已建立，Private Vulnerability Reporting 已開啟） |
| Git | 公開 repo 的歷史只由 export 的檔案集合組成，不含開發 repo 的歷史 | 每次更新重新 export＋掃描，再以一般 push 更新 |
| 個人資料 | §2：export＋掃描 0 命中 | 每次 release 重跑 |

## 2. 個人資料與秘密清理

2026-10-31 掃描（`grep -rliE`，排除 `node_modules`／`dist*`／`.git`）的命中類別：

| 類別 | 命中位置（類別層級） | 處理 |
|------|----------------------|------|
| 本機暫存路徑（`/private/tmp/…`） | 原 case 的私人 runbook（不公開） | 改為 `<path-to-rpc-url-file>` 佔位 |
| 使用者家目錄路徑 | `.claude/cache/…`（工具快取） | 不納入 repo（`.gitignore`） |
| 密碼管理器 reference（`op://`） | `test/fixtures/keystore.ts`（測試假資料） | 確認為 synthetic；改為明顯的假值 |
| 原 case 的 recipient | 原 case 的私人文件、`src/config/constants.ts`、`test/e2e/withdraw.spec.ts`（README 已於 2026-10-31 移除） | 開源版改為 per-user 輸入；文件中以「使用者指定的收款地址」取代 |
| 原 case 的 gas wallet | 原 case 的私人文件、`src/config/constants.ts` | 同上，移除 |
| 原 case 的 wallet | README、兩個舊 feature、研究證據 | 研究證據**不修改**（hash 鎖定），且不在公開 export（allowlist 不含維護者的研究資料夾）；公開文件不寫原 case 錢包地址，縮寫也不寫（§5.4） |
| 完整餘額 | 研究紀錄、舊 runbook | 新文件不寫；舊文件釋出前移除或改為「部分資產」 |

公開檔案集合以明確 allowlist 組成（`scripts/release/public-allowlist.json`，`export.mjs` 輸出 `MANIFEST.sha256` 與 digest）；維護者的研究資料夾、`requests/`、原 case 文件、`.claude/`、spike 都不在其中，公開文件裡對它們的引用改為純文字（不是連結）。`scripts/release/scan.mjs` 掃描 export：家目錄／暫存路徑、session 產物、RPC URL 內的 key、私鑰與助記詞、`op://`、email、WebAuthn assertion、keystore、私人資料的引用；另以 repo 外的私人 deny list 比對個人名稱、地址與 tx（命中只報規則與位置，不印出詞）。CI 另跑 gitleaks（版本與 sha256 釘選，`.gitleaks.toml` 只放行 Anvil 公開 dev key 與 synthetic 標記）。Release tag 前必須 0 命中。

## 3. 可重現建置與 CI

| 項目 | 規劃 |
|------|------|
| Runtime | `.nvmrc`（Node 24.22.1）、`packageManager` 欄位、`npm ci` |
| Lockfile | 必須 commit；CI 驗證 `npm ci` 不改 lockfile |
| Foundry／anvil | runner 用 `@foundry-rs/anvil-*` 1.7.1（optional dependency，各平台 sha256 釘選）；CI 檢查 sha256 後放進 PATH；合約重建 job 用 foundry-toolchain v1.7.1 |
| 建置 | `npm run build`；產物 SHA-256 寫入 release notes |
| CI jobs | `.github/workflows/ci.yml`（action 以 commit SHA 釘選、`npm ci --ignore-scripts`）：typecheck、unit、build、hosted build、license check、`npm audit --audit-level=high`、export＋scan、gitleaks、wrangler dry-run；clean export 單獨 build／unit；integration（anvil testchain）；e2e（Playwright chromium＋axe，含 hosted／local 流程）；runner 套件 pack＋`npm exec`；合約重建（手動觸發） |
| 不在 CI | live RPC 測試（手動）、任何主網交易 |
| Release | `scripts/release/pack-smoke.mjs`：`npm pack`＋在乾淨暫存目錄真實 `npm exec`（隔離 npm cache／userconfig／store，不改 HOME），輸出 tarball、sha256 與 `pack-smoke.json`；維護者上傳到 GitHub Release 並 read-back（[release plan](../../release/release-plan.md)）；`private: true` 防止 `npm publish` |

## 4. 社群文件

| 檔案 | 內容 |
|------|------|
| `README.md` | 這是什麼、適用與不適用、快速開始、安全模型、限制、credit |
| `SECURITY.md` | 私下回報管道（GitHub Security Advisories）、回應時間目標、範圍；**明確說明不接受任何人寄送 seed／私鑰作為「協助」** |
| `CONTRIBUTING.md` | 開發環境、測試、review 流程、synthetic 資料規則 |
| `CODE_OF_CONDUCT.md` | 自寫的簡短準則（2026-11-02 決定：針對救援情境補上「不索取秘密、不冒充、不提供救援服務」） |
| `docs/` | `INSTALL.md`／`INSTALL.zh-TW.md`、`AI_COLLABORATION.md`、`release/`、本 feature 文件（不含 `requests/`）；回顧紀錄不公開 |
| Issue templates | `bug_report.yml`（附 redacted report、勾選不含秘密）、`unsupported_wallet.yml`、`config.yml`（關閉空白 issue、security 導向私下回報）；`PULL_REQUEST_TEMPLATE.md` |

## 5. 官網規劃

### 5.1 原則

| 原則 | 規則 |
|------|------|
| 獨立 origin | 官網是同一份 UI 的靜態 hosted build（`npm run build:hosted`）；讀鏈與模擬在使用者本機的 runner；瀏覽器錢包自己廣播，File／native payer 的交易經 runner 驗證後轉送（[`5-hosted-local-runner.md`](./5-hosted-local-runner.md)） |
| 只經配對連本機 | 不自動探測或請求 localhost；使用者輸入代碼並按「Connect」後才有 preflight 與握手（同一次按下依序 `/api/hello`、`/api/pair`），讀鏈、模擬與送出等受保護 API 要有效的 pair token；runner 只接受 exact-origin allowlist；CSP `connect-src 'self' https://rpc.plasma.to http://127.0.0.1:*`（`_headers`，`hosted-headers.test.ts`）；runner 以 exact-origin allowlist、一次性代碼與 origin 綁定的 session token 拒絕其他網站 |
| 不收秘密 | 秘密永不送往 hosted service：瀏覽器 File 的 keystore 與密碼只在分頁記憶體處理（加密下載備份），native File／1Password 的操作直接送往已配對、隔離的 signer 子程序；沒有 seed／recovery phrase 輸入，也沒有「上傳 seed／key 檢查」之類功能 |
| 無追蹤 | 不載入 analytics、第三方字型或 CDN |
| 誠實 | 只寫已驗證的事；限制寫在首頁，不藏在 FAQ |

### 5.2 頁面 IA

工具與網站是同一個 SPA，以**真實路徑**切換（路由規則與兩種 host 的行為見 [design-ui-ux-guidelines.md](./design-ui-ux-guidelines.md) §13.3；`src/ui/site/routes.ts`、`server/staticRoute.ts`）：

```
/               首頁（Recovery Atlas，結構見 6-recovery-atlas.md §3）：hero＋主圖、三步驟縮圖、適用與不適用、產品 Demo（逐張）、誰握有什麼（轄區圖，只講一次）、狀態 ledger、FAQ（#faq）
/recover        救援工具本身（切到其他頁時保持掛載，進度不會遺失）；runner 啟動時印出這個位址
/guide          步驟：網站與本機 runner、bookmarklet 主流程、DevTools fallback、gas 模式
/how-it-works   架構與信任邊界；開頭說明「你正在哪裡閱讀」（依 pageKind，6-recovery-atlas.md §10.4）
/security       安全模型、回報方式、非官方聲明
/download       目前有什麼（原始碼已公開、Runner Release 尚未發布、網站尚未部署）、git clone→Node／npm→npm ci／build→npm run runner、本機打包 npm pack／sha256／npm exec、發布之後（規劃中）的 Release 網址（文字）；見 6-recovery-atlas.md §10.5
其他            Not found 頁（hosted 與 runner 都回 HTTP 404）
```

Hosted build 為每頁寫一份 `<path>/index.html`（同一份 build），Workers 以 `not_found_handling: "404-page"`、`html_handling: "drop-trailing-slash"` 提供，沒有 SPA fallback。舊的 `#/home`、`#/recover` 等連結載入時轉到對應路徑（保留 query）。語言以頁首切換（EN 預設、完整繁中），不另開 `/zh-tw/` 路徑。沒有 `/case` 頁（§5.4）。

### 5.3 首頁文案（English 預設）

| 區塊 | English | 繁中 |
|------|---------|------|
| Hero | Your address is there. Your wallet may not be ready. | 地址還在，錢包可能尚未就緒。 |
| Sub | For Coinbase Smart Wallet v1.1 accounts made with a passkey that received funds on Plasma. Check first whether your case fits: the tool reads your wallet, places it at the same address only if it is needed and compatible, and you approve each transfer yourself with your passkey. | 適用於以 Passkey 建立、在 Plasma 上收過資產的 Coinbase Smart Wallet v1.1。先確認你的情況是否適用：工具讀取你的錢包，只在需要且相容時部署到同一個地址，每一筆轉帳都由你本人用 Passkey 核准。 |
| CTA | Check your wallet（`/recover`）／See how it works（第二段）；範圍行：Needs the runner on your computer. Independent and not audited. | 檢查錢包／看看運作方式；範圍行：需要在你的電腦上執行 runner。獨立專案，尚未經過稽核。 |
| For you if | You created a Coinbase Smart Wallet with a passkey. Funds were sent to that same address on Plasma (chain 9745). The Coinbase app can’t move those funds on Plasma — often because the wallet was never deployed there. | 你用 Passkey 建立過 Coinbase Smart Wallet。有人把資產轉到你在 Plasma（chain 9745）上的同一個地址。Coinbase app 無法動用 Plasma 上的這些資產——常見原因是錢包從未部署在 Plasma。 |
| Not for | A lost passkey. Nothing here can replace it. Seed-phrase wallets or other smart wallet brands. Any chain other than Plasma. | 遺失的 Passkey。這裡沒有任何東西能取代它。seed phrase 錢包，或其他品牌的 smart wallet。Plasma 以外的任何鏈。 |
| Who holds what | Each place holds only what it must, and only these channels connect them.（轄區圖四區與通道，逐項文案見 `src/ui/site/copy-site.ts` 的 `bound.*`；2026-11-02 PM 修訂後首頁只講這一次） | 每個地方只持有必要的東西，彼此之間只有這幾條通道。（同一組 `bound.*`） |
| Status（2026-11-02 更新；`src/ui/site/copy-site.ts` 的 `ledger.*`，首頁以 status ledger 逐列呈現） | Early release. One mainnet transfer has been made and checked with this tool, using the runner's existing gas wallet mode (keystore + 1Password); the other gas modes are tested only on a synthetic test chain. The method it automates recovered one real Coinbase Smart Wallet v1.1 on Plasma. Not audited. | 早期版本。已用這個工具以 runner 的「既有 gas 錢包（keystore＋1Password）」模式完成並核對一筆 mainnet 轉帳；其他 gas 模式只在 synthetic 測試鏈上測試過。它自動化的方法曾救回 Plasma 上一個真實的 Coinbase Smart Wallet v1.1。尚未經過稽核。 |
| Unofficial | Passkey Recovery is an independent project. It is not affiliated with, endorsed by, or supported by Coinbase or Plasma. | Passkey Recovery 是獨立專案，與 Coinbase、Plasma 無任何隸屬、背書或支援關係。 |
| Credit（footer，`src/ui/copy.ts` 的 `footer.*`；「Source code」連到公開 repository） | Built by sd0x · github.com/sd0xdev · Source code · Built with sd0x-harness · Apache-2.0 | 由 sd0x 製作 · github.com/sd0xdev · 原始碼 · 以 sd0x-harness 打造 · Apache-2.0 |
| 贊助（footer 的次要按鈕，`SPONSOR_URL`，與 `.github/FUNDING.yml` 同一個 Stripe 頁面；新分頁開啟，不帶 query，不在救援步驟內） | Sponsor this project | 贊助這個專案 |

連結：harness `https://github.com/sd0xdev/sd0x-harness`、作者 `https://github.com/sd0xdev`。repo `https://github.com/sd0xdev/passkey-recovery`（`src/config/release.ts`）公開之前，網站不連到它：Download 只把規劃中的 Release 網址當文字列出，其他頁寫「原始碼資料夾裡的檔案」（2026-11-02 PM 修訂）。

### 5.4 案例證據（不公開）

2026-11-02 決定：公開網站與公開 repo **不放**原 case 的 tx hash、block、錢包地址（含縮寫）。tx hash 直接指向那個錢包與收款地址，等於公開一位真人的鏈上身分；「原方法曾救回一個真實案例」的說法由維護者保存的私人證據支撐（產品本身的 mainnet 驗證只有 2026-11-02 PM 以 keystore＋1Password 模式完成的一筆，見 `2-tech-spec.md` §0 的 Update 註記），公開版不附可追溯的鏈上連結。網站沒有 `/case` 頁。若日後要公開案例，需要當事人明確同意，並另開需求。

### 5.5 禁用的宣稱

| ❌ 不寫 | ✅ 改寫 |
|---------|--------|
| Works with any wallet／any chain | Works with Coinbase Smart Wallet v1.1 on Plasma |
| Guaranteed recovery／Verified on mainnet（概括成所有模式）／Verified on one real case（指本產品） | The method recovered one real case; this tool made one checked mainnet transfer in the existing gas wallet (keystore + 1Password) mode; the other gas modes are tested on a synthetic chain only |
| Fully audited／secure | Not audited. Here's the security model. |
| No Console needed（真實工具列＋OS Passkey 驗收通過前，見 [M2 手動 checklist](./checklist-m2-manual-verification.md)） | Signing currently needs an advanced manual step |
| Official Coinbase tool | Independent, not affiliated |
| Your funds are safe with us | We never hold your funds or keys |

## 6. Release plan

| 階段 | 出口條件 |
|------|----------|
| R0 規劃（本次） | 文件 review 通過 |
| R1 私有 alpha | M1–M4 完成（2026-10-31，synthetic）；全部測試通過；secret scan 0 |
| R2 公開原始碼 | LICENSE（Apache-2.0）加入；§2 清理完成；社群文件；CI 綠燈 —— 2026-11-02 本機完成檔案、export（掃描 0 命中、乾淨重建與測試通過）；2026-11-07 repo 建立、CI 通過 |
| R3 官網 | §5 頁面完成；CSP 與 network log 檢查（使用者觸發配對前無 loopback 請求；握手只有 preflight、`/api/hello`、`/api/pair`；受保護 API 都帶 pair token；無第三方請求） —— 2026-11-02 頁面完成（`site.spec.ts`），尚未部署；部署與 runtime read-back 見 [deploy plan](../../release/deploy-plan.md) |
| R4 extension（條件式） | ADR-001 S2 go＋ADR-002 |

M3/M4 這一 run（R1 之前）AI 不建立 public repo、不部署網站、不 git add／commit／push。R2／R3 的公開（Apache-2.0、`sd0xdev/passkey-recovery`、Workers Static Assets on workers.dev）是維護者已核准的事項，M5 release run 不需再問，但只在以下條件都成立後才執行：產品通過驗收；§2 清理完成；發布檔案以明確 allowlist 組成（不 `git add .`）；從乾淨的檔案集合重新安裝、建置與測試通過；發布前重新核對 GitHub 帳號與 repo 名稱。R4 與正式網域仍由維護者另行決定；任何階段都不改動既有的其他 Workers、DNS、repo 或付費方案。
