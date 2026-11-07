# Passkey Recovery by sd0x — Tech Spec（開源版規劃）

> **Doc class**: Lifecycle — Phase 2 tech spec（current authority）。M1–M4 與 hosted／local 統一產品已實作（§0、§8）；原 case 的固定限制版本只剩歷史紀錄（維護者的私人紀錄，不在公開 repo）。
> **Intent**: [intent-open-source-recovery.md](./intent-open-source-recovery.md) · **Requirements**: [1-requirements.md](./1-requirements.md) · **Architecture**: [3-architecture.md](./3-architecture.md) · **ADR**: [adr-001-no-console-signing.md](./adr-001-no-console-signing.md)、[adr-002-extension-bridge.md](./adr-002-extension-bridge.md)、[adr-003-local-runner-pairing.md](./adr-003-local-runner-pairing.md)、[adr-004-bookmarklet.md](./adr-004-bookmarklet.md)

## 0. Current Status（2026-10-31，2026-11-01 更新）

| M | 狀態 | 說明 |
|---|------|------|
| M0 | ✅ 完成 | 規劃文件、回顧紀錄 |
| M1 | ✅ 實作＋自動化驗證 | RPC 層（§3.3）；live probe（`npm run test:live`）為手動，2026-11-01 通過 |
| M2 | ✅ spike 完成＋bridge preview（proof kind） | S2 go（virtual 層）、S1 備案、S3 外部阻塞、S4 no-go（spike 紀錄（`requests/2026-10-31-m2-spike-results.md`，私人紀錄，不公開））；真實 OS passkey 層待 [手動 checklist](./checklist-m2-manual-verification.md) |
| M3 | ✅ 實作＋自動化驗證（synthetic testchain） | per-user intent／診斷／部署／轉帳／追蹤（§3.2–§3.7）；AC 見 M3／M4 request（`requests/2026-10-31-m3-m4-local-product.md`，私人紀錄，不公開） |
| M4 | ✅ 實作＋自動化驗證（e2e＋axe） | Logbook UI（§3.8）；VoiceOver 實機巡覽待手動 |
| Unified | ✅ 實作＋自動化驗證（synthetic／virtual） | 三種 gas 錢包、本機 runner、hosted 配對、bookmarklet（§8）；AC 見 2026-11-01 request（`requests/2026-11-01-unified-hosted-local-gas-wallets.md`，私人紀錄，不公開）；hosted 網站未部署 |
| M5 | ✅ 本機成品完成（未公開） | 開源發布（§3.11、§5）：community 檔、allowlist export＋掃描、runner tgz＋`npm exec` smoke、CI workflow、deploy／release plan；repo 建立、CI 執行、release 與部署待維護者 |

**不宣稱**：mainnet 上以本產品完成過轉帳（只在 synthetic testchain 驗證）；「不需要 Console」（真實 passkey 層完成前，README／官網不得使用此字樣，UI 只可在 bridge 區塊標示預覽，與 `src/ui/ExtensionBridge.tsx` 一致）；hosted 網站已部署（只有 `dist-hosted/` build）。

> **Update(2026-11-07)**：公開 repository `sd0xdev/passkey-recovery` 已建立、CI 通過。上表 M5 的「未公開」與「repo 建立、CI 執行待維護者」自此縮小為：tag、GitHub Release、tarball 與網站部署仍待維護者。

> **Update(2026-11-02)**：PM 以 runner 的「既有 gas 錢包（keystore＋1Password）」模式完成一筆 1 USDT0 mainnet 轉帳並自行核對（PM 紀錄，不公開 tx 細節）。上面「不宣稱 mainnet 轉帳」自此縮小為：不宣稱其他 gas 模式或其他流程已在 mainnet 驗證，也不把這一次概括成整體已驗證。

### 0.1 Acceptance Ledger（M1、M2）

| AC | 內容 | 證據（自動化） | 層 |
|----|------|----------------|----|
| M1-1 | 沒有 `CBPR_RPC_URL_FILE` 時預設 `https://rpc.plasma.to` | `server/config.ts` `PUBLIC_RPC`；live probe 手動 | unit／live |
| M1-2 | Capability probe：chain（chainId＋genesis）、read、consistency、estimate、state override、fork、archive；broadcast 不 probe | `test/unit/rpc/probe.test.ts`；e2e `rpc-settings.spec.ts`「checking the testchain runs every capability」 | unit、e2e |
| M1-3 | 自訂 RPC 只在 session 記憶體；遮罩 `scheme://•••/…`（DNS 主機名不顯示任何 label，IP literal 與 port 保留）；Clear 與 reload 後消失 | `registry.test.ts`、`guard.test.ts`「maskUrl…」、e2e「use, refuse another genesis, clear, and a reload…」 | unit、e2e |
| M1-4 | SSRF：每個解析位址都檢查、連線 pin 到已驗證 IP、不跟 redirect、忽略環境 proxy、拒絕 sidecar 自己的 port | `test/unit/net/guard.test.ts` | unit |
| M1-5 | 自架例外需 `allowLocal`＋輸入 `MY OWN NODE`；metadata 位址永不通過；持續 banner | `registry.test.ts`、e2e「a private address is refused without the exception…」 | unit、e2e |
| M1-6 | 429／-32005 退避 500ms、1s、2s 後明確失敗 | `probe.test.ts`「rate limiting is retried…」 | unit |
| M1-7 | 切換、清除、re-check 都 bump epoch，舊 plan／deploy preview 作廢；頁面上經舊端點讀到的檢查結果也作廢（Check 重新開啟、帳戶地址保留；切換前送出、之後才回來的檢查不採用）；reload 中的 Use 不會落地；chain／read 不 ok 時拒絕建 plan | `test/unit/rpc/registry.test.ts`（epoch）、`test/integration/rpc-registry.test.ts`「a plan built on the base endpoint is discarded…」、`test/e2e/flow.spec.ts`「an RPC re-check started while the wallet is still checking…」 | unit、integration、e2e |
| M1-8 | URL／key 不出現在任何 state、report、錯誤訊息 | `registry.test.ts`「no state, report or error…」、`upstream.test.ts` redaction | unit |
| M2-S1 | Bookmarklet go／no-go 有可重現證據 | S1 spike harness 3/3（私人紀錄） | virtual official-origin |
| M2-S2 | Extension go／no-go 有可重現證據（真實 origin、安全機制全開、production manifest） | S2 spike bridge harness 3/3、原始 spike（私人紀錄） | virtual official-origin |
| M2-S3 | SDK chain 9745 | 來源研究；popup 需真實帳號 → **外部阻塞** | source |
| M2-S4 | `wallet_sign` raw hash | ERC-7871＋SDK 來源；當時的 synthetic testchain 測試 `s4-replay-safe.test.ts` 已隨固定 case 模組在 M3 移除（歷史證據，不在目前 tree；原檔保存於 M3／M4 run 的 `backup/removed-fixed-case/`） | source、歷史 synthetic testchain |
| M2-B1 | Bridge：exact sender、strict protocol、exact sign page、一次性配對、challenge 綁定、RAM-only、結果只取一次 | `test/unit/bridge/protocol.test.ts`、`client.test.ts`；bridge harness 對照組 | unit、virtual |
| M2-B2 | 本機 UI 走完 proof 全程；非 4173 origin 不提供 bridge、不送任何訊息 | bridge harness happy path；e2e「the extension bridge is offered only on 127.0.0.1:4173…」 | virtual、e2e（mock） |
| M2-R | 真實工具列點擊＋真實 OS passkey | [手動 checklist](./checklist-m2-manual-verification.md) | ⏳ real（未執行） |

## 1. Requirement Summary

**Problem**：現行工具只為一個錢包、兩筆固定金額設計，並依賴 DevTools Console、私有 RPC 檔與 Terminal 廣播。要讓同類使用者安全重用，必須改成 per-user intent、UI 內完成部署與轉帳、公開 RPC 為預設，同時保留所有已證明有效的安全關卡。

**Goals**：G1–G9（`1-requirements.md` §2）。**Scope**：M1–M5（§5），逐 milestone 實作。**Out of scope**：放寬財務關卡、AI 簽署或送出、持有金鑰的 API、把使用者的 keystore 或私鑰交給網站／sidecar 主程序（只在分頁記憶體或 runner native signer）、RPC secret、原始證據檔。

### 1.1 Traceability（原始需求 → 方案 → 可觀測 AC → 驗證層 → roadmap）

| 原始需求 | 方案（本文件／相關文件） | 可觀測 AC | 驗證層 | Roadmap |
|----------|--------------------------|-----------|--------|---------|
| 開源 | `4-open-source-and-website.md` §1–§4 | 乾淨機器依 README 建置＋測試通過；secret scan 0 命中 | CI、手動重現 | M5 |
| 不用 DevTools Console | ADR-001、`0-feasibility-study.md` | spike S1／S2 有 go 紀錄前，UI 不出現「免 Console」字樣；go 後走完簽署不開 DevTools | spike 紀錄、e2e（mock extension bridge） | M2 |
| UI 部署 | §3.4、`3-architecture.md` §4 | 3 步驟各自 EIP-1193 確認；完成後 code hash＋owner 驗證 pass | unit、integration（testchain）、e2e（EIP-1193 mock） | M3 |
| UI 轉帳 | §3.5、`3-architecture.md` §5 | 預覽 7 欄綁定；pending → confirmed／inner-failed 分支 | unit、integration、e2e | M3 |
| 公開 RPC 預設＋UI 自訂 RPC | §3.3 | 預設 `https://rpc.plasma.to`；自訂 RPC 遮罩、清除、reload 後消失；SSRF 拒絕 | unit、e2e、live（手動） | M1 |
| 全新 UI（frontend-design、iOS 27 Liquid Glass 參考） | `design-ui-ux-guidelines.md` | token 實作、axe 0 serious、鍵盤走完全程 | e2e＋axe、手動 VoiceOver | M4 |
| 文件與 AI 協作 | `runbook-ai-collaboration.md` | redacted report 不含 secret pattern；AI 無簽署／送出入口 | unit（redactor）、source scan | M4 |
| 簽署與送出是人的決定 | INV-003、§3.5 | 送出按鈕只在 signed simulation pass 後出現，且需二次確認 | e2e | M3 |
| 作者 credit 與 GitHub | `4-open-source-and-website.md` §5 | UI footer、README、官網都連到 `https://github.com/sd0xdev` | e2e（連結）、doc review | M4 |
| 官網 | `4-open-source-and-website.md` §5–§6 | 同一份 UI 的靜態 build（[`5-hosted-local-runner.md`](./5-hosted-local-runner.md)）；不自動探測或請求 localhost；使用者輸入代碼並按「Connect」後才有 preflight 與握手（同一次按下依序 `/api/hello`、`/api/pair`），讀鏈、模擬與送出等受保護 API 要有效的 pair token；runner 只接受 exact-origin allowlist；secret 不送往 hosted service，不收 seed／recovery phrase | CSP 檢查、network log | M5 |
| 救援回顧 | `../../research/2026-10-31-rescue-retrospective.md` | 文件存在、無個人路徑、原證據 hash 不變 | doc review、hash 檢查 | M0（本階段完成） |

## 2. Existing Code Analysis

M3 移除原 case 的固定值與依賴它們的模組（`server/{evidence,verifyTx,service}.ts`、`src/withdraw/*`、`src/userop/{readiness,calldata,recipient,amount}.ts`、`src/rpc/client.ts`、舊 UI 面板），以下列模組取代；原檔保留在 run 外置備份，不在 repo。

| 原 case（固定） | 現在（per-user） |
|-----------------|------------------|
| `WALLET`、`WITHDRAW_RECIPIENT`、1 XPL／1 USDT0、`MAX_WITHDRAWALS` | `src/transfer/intent.ts`：使用者輸入 source／recipient／asset／amount，無預設；上限是「≤ 可用餘額」（native 再扣 reserve，§3.6） |
| nonce 只允許 0／1＋`priorTxHash` | `server/transfer.ts`：preview、signature、send-request 三處各讀一次 live EntryPoint nonce（key 0）；不同即作廢 |
| `OWNER0_PUBKEY`、`OWNER1_ADDRESS` | `server/diagnose.ts`＋`src/wallet/derive.ts`：已部署讀鏈上 owners；未部署由 evidence 推導（D4） |
| `server/evidence.ts` 的 hash-pinned 部署 | `server/bytecodeRegistry.ts`＋`registry/coinbase-smart-wallet-v1.1/`（公開、去個人化、sha256 釘選於 `src/config/registry.ts`）＋`server/deploy.ts` |
| Terminal-only broadcast | 使用者的 EIP-1193 錢包（`src/wallet/eip1193.ts`）；Terminal signer 保留為進階 hand-off（§3.5） |
| `server/verifyTx.ts` post-send 驗證 | `server/track.ts`：無狀態追蹤 |

**保留不變的關卡**：counterfactual address 驗證、ERC-1967 implementation slot 與 owner 順序（`server/state.ts`）、P256 precompile 不存在時的 FreshCryptoLib fallback gas（`server/p256probe.ts`、`server/sim.ts`）、exact signed fork simulation（`server/fork.ts`、`server/sim.ts`）、immutable plan、nonce freshness、no silent replay、twin 讀自己的 nonce。

## 3. Technical Solution

### 3.1 元件與部署形態

```
┌──────────── 使用者的瀏覽器（loopback origin http://127.0.0.1:4173）──────────────┐
│ Recovery UI（React，靜態 bundle，無 CDN）                                         │
│   ├─ EIP-1193 provider（使用者的 gas wallet，例如 browser wallet extension）     │
│   ├─ Signing bridge（ADR-002：MV3 extension；進階 Console）                      │
│   └─ fetch → Local sidecar（同 origin，session token）                           │
└──────────────────────────────────────────────────────────────────────────────────┘
（4173 是 bridge 的 protocol 一部分：改 port 必須同時改 `extension/manifest.json` 的 `externally_connectable`、`extension/protocol.js` 的 `APP_ORIGIN`、`src/bridge/client.ts` 的 `BRIDGE_APP_ORIGIN`，並讓 app 實際在新 port 提供（sidecar `CBPR_PORT`、`npm run preview` 的 `--port`））
Local sidecar（Node，127.0.0.1，無金鑰）：RPC 代理（allowlist）、capability probe、anvil fork 模擬、追蹤
Public RPC（預設 https://rpc.plasma.to）或使用者自訂 RPC
官網（獨立 origin，靜態 hosted build）── 使用者明確配對後 ──▶ 本機 runner（127.0.0.1，exact-origin CORS＋pair token；見 5-hosted-local-runner.md §3）
```

信任邊界、資料流與 sequence 見 `3-architecture.md` §2–§3。**Backend／frontend 分工**：瀏覽器負責 intent 輸入、顯示、確認與 EIP-1193／簽署 bridge；sidecar 負責需要 Node 的事（anvil fork、跨 origin RPC 呼叫的 SSRF 檢查、ABI 嚴格解碼後的模擬結果）。Sidecar 不持有任何金鑰。廣播：使用者的 EIP-1193 錢包自己送；2026-11-01 起 op／File payer 另經 sidecar 的 relay 端點（`/api/transfer/relay`、`/api/deploy/send`），只轉送 sidecar 自己 issue、解碼欄位與 recover 簽署者都相符的 raw tx（`server/relay.ts`、`server/deployRelay.ts`；§8、[`5-hosted-local-runner.md`](./5-hosted-local-runner.md) §4）。

### 3.2 診斷（Diagnosis）

輸入：`chainId`、`wallet address`。輸出：`DiagnosisReport`（`3-architecture.md` §6.1）。

| 步驟 | 檢查 | 失敗時 |
|------|------|--------|
| D1 | `eth_chainId` 為 9745 且 genesis hash 與 `src/config/chains.ts` 釘選值相同（首版唯一支援鏈；沒有選鏈 UI） | `unsupported-chain` |
| D2 | EntryPoint v0.6、Safe singleton factory、implementation v1.1、factory v1.1 的 code hash | EntryPoint 或 Safe singleton factory 缺少 → `unsupported-chain`（我們不部署這兩者，fail closed）；implementation／factory 缺少 → 列入 §3.4 部署步驟；任何 hash 不符 → `unknown-code` |
| D3 | wallet 有 code：讀 ERC-1967 slot＝implementation v1.1、`ownerAtIndex(i)`、`nextOwnerIndex` | slot／owner 不符 → `unknown-owner` |
| D4 | wallet 無 code：使用者提供 owners＋factory nonce（或從他鏈的 deployment evidence 匯入，hash pin）。推導兩種方式都要做且一致：(a) 本機以 CREATE2 公式計算（factory 地址、`salt = keccak256(abi.encode(owners, nonce))`、pinned proxy init code hash）；(b) factory 已在鏈上 → `eth_call factory.getAddress`；factory 尚未部署 → 在 fork 上先以 pinned evidence 部署 implementation＋factory 再呼叫 `getAddress` | 任一結果 ≠ wallet → `derivation-mismatch` |
| D5 | 資產：native 餘額、allowlist 內 ERC-20 餘額、EntryPoint deposit | 讀取失敗 → 顯示 `unknown`，不以 0 代替 |
| D6 | 簽署方式：owner 類型（64-byte 公鑰＝passkey／32-byte 地址＝EOA）。鏈上只存公鑰 bytes，**沒有 RP ID**，所以診斷只能標示「passkey owner，RP 待簽署時確認」；RP 在簽署時由 assertion 的 `clientDataJSON.origin` 與 `rpIdHash`（`src/webauthn/verify.ts`）確認必須是 `keys.coinbase.com`，且公鑰必須等於該 owner | 簽署時 RP／公鑰不符 → `unsupported-owner`，不組 signature |

**跨 chain／跨錢包**：支援矩陣是 allowlist（`SUPPORTED = [{chainId, entryPoint, factory, implementation, codeHashes}]`），每新增一組都要有 testchain 測試＋live read 證據。第一版只列 Coinbase Smart Wallet v1.1 × Plasma 9745。其他 wallet 家族（Safe、Kernel、Biconomy 等）**不在範圍內**，D2／D3 會回 `unknown-code`。

### 3.3 RPC 層

| 能力 | Probe | 用途 | 不支援時 |
|------|-------|------|----------|
| read | `eth_chainId`、`eth_getBlockByNumber`（latest）、`eth_getCode` | 全部 | 停止 |
| estimate | `eth_estimateGas`、`eth_call` with state override | 預覽 | 改用 fork 估算 |
| fork | anvil `--fork-url` 能在 head block 初始化並讀到 wallet 狀態（以 `--accounts 0` 啟動，不建立會被灌餘額的 dev account，模擬只看真實餘額） | 模擬 | 停止在「無法模擬」，不允許簽署 |
| archive | 讀 `head − 10000` 的 `eth_getBalance` | 追蹤舊交易時的佐證 | 只用 receipt／logs |
| broadcast | 不 probe（不送測試交易，也無法以唯讀方式可靠判斷） | `wallet` payer：廣播交給使用者的 EIP-1193 錢包與它自己的 RPC，不經我們；op／File payer：sidecar relay 以目前 RPC 轉送已驗證的 raw tx（§8） | — |

- **一致性**：同一次預覽／模擬的所有讀取綁定同一個 `blockNumber`＋`blockHash`（snapshot 結束時再讀一次該 block，hash 變了即重試）；fork 以該 block 建立，並在執行工作前核對 fork 上該高度的 block hash 等於 snapshot 的 hash（`ForkManager.run({ block, blockHash })`），不同即拒絕（snapshot 之後或排隊期間發生 reorg）。不同 RPC 回的 chainId 不同即停止。
- **Rate limit**：429／`-32005` 指數退避（500ms、1s、2s），3 次後提示改用自訂 RPC；不靜默降級。公開 RPC 官方標示「Rate limited and not for production systems」。
- **Fallback**：使用者可加第二個 RPC；切換時重新 probe 並重做預覽（舊預覽作廢）。
- **自訂 RPC**：只存在 sidecar 與 UI 的 session 記憶體；UI 只顯示 `scheme://•••[:port]/…` 遮罩（DNS 主機名的任何 label 都不顯示，因為 label 本身可能是 key；只有 IP literal 與 port 保留，`server/net/guard.ts` `maskUrl`）；提供「測試連線」與「清除」；不進 URL、log、AI report、匯出檔。
- **SSRF**：sidecar 只接受 `https:`（自架例外允許 `http:` 但僅限使用者明確勾選）；DNS 解析出的**每一個**位址都必須通過檢查（拒絕 loopback、RFC 1918、link-local、CGNAT、ULA、IPv4-mapped IPv6、metadata 169.254.169.254），任一不通過即拒絕；連線**綁定到已驗證的那個 IP**（自訂 lookup，TLS SNI／Host 仍用原 hostname），不再做第二次解析，以防 DNS rebinding；不跟隨 redirect；忽略環境的 HTTP proxy 設定（proxy 會繞過 IP 檢查）。自架例外需要使用者輸入確認文字，並在畫面上持續顯示。
- **不承諾**：公開 RPC 是否永遠提供 historical state／trace。2026-10-31 單次探測：`reth/v2.7.0`、block 1 的 `eth_getBalance` 有回應、`debug_traceCall` 方法存在（參數錯誤回 -32602），**這些不是保證**。

### 3.4 部署（UI，EIP-1193）

`server/deploy.ts`。步驟只來自 registry（Safe singleton factory 上的 implementation、factory）與從已驗證 evidence 重新編碼的 `createAccount(owners, nonce)`；目標地址已有預期 code 的步驟跳過（由鏈上狀態決定，不是 receipt）。沒有 creation evidence（owners＋nonce）時沒有錢包這一步可列，因此最新 snapshot 上錢包本身必須已部署，否則拒絕規劃（409），不會因「沒有缺少的步驟」而回報完成。整份 plan 先以 synthetic sender 在 fork 上跑完，終態（code hash、slot、owners）驗證通過才提供任何步驟。每一步：UI 顯示 to、data hash、value 與**估計**費用（最終以錢包確認畫面為準）→ 使用者按下步驟按鈕＋確認 sheet → 頁面立即重新規劃（步驟已被他人完成、交易內容或手續費上限改變時不呼叫錢包，顯示更新後的步驟請使用者再確認）→ EIP-1193 錢包確認 → `/api/deploy/track` 以 tx hash 無狀態驗證（exact from／to／input／value／chainId、receipt success、目標 code）。錢包拒絕不送任何東西；錢包沒回 hash 時重新規劃（已上鏈的步驟會被跳過），不重送。呼叫錢包**之前**先寫一筆 deploy record（`cbpr.deploy.v1`，§3.7），拿到 hash 後更新；重新整理後頁面依這筆紀錄繼續追蹤該步驟（有 hash 就驗 hash，沒有 hash 就從鏈上重新規劃），不會再把同一步當成新步驟提供。步驟驗證通過、錢包拒絕、或使用者自己按下重新規劃時才清掉紀錄。部署步驟在錢包 adapter 的 account／chain 預檢期間被離開（RPC 切換、回到 Check）時，`eth_sendTransaction` 之前的最後檢查會放棄這次請求（`cancelled`，錢包未被詢問），並清掉**這次嘗試自己寫下的**紀錄（`clearDeployIf`：只有儲存的紀錄仍是它寫的那一筆時才刪除，取得 hash 時的更新也一樣）：使用者離開後重新規劃並送出的較新嘗試，其紀錄不會被較舊嘗試遲到的回應刪掉或覆寫。「重新規劃」與「再檢查一次」在規劃進行中停用，不會同時跑兩次；它們的結果若在一次新的送出嘗試寫下紀錄之後才回來，就被丟棄（不清紀錄、不把步驟改回可送出）。錢包對較舊嘗試的遲到回答（拒絕、hash、無 hash、錯誤；例如切換 gas wallet 並重新規劃之後才回來）同樣只動它自己的紀錄，不取代最新嘗試在畫面上的狀態。部署 calldata 只顯示、不能編輯。進階的 Terminal 路徑（`npm run signer -- deploy`，`server/signer/core.ts`）每次執行只送一步，套用同樣的狀態規則：每個 snapshot（規劃後、確認後簽署前）都重新推導「下一個缺少的步驟」，必須仍是使用者確認的那一步（例如 factory 在確認期間被 reorg 移除，下一步變成 factory，就不簽署）；每次 fork 模擬後讀回該步驟的目標 code（account 另驗 slot 與 owners），沒有產生預期 code 就不簽署——對沒有 code 的地址呼叫 `createAccount` 也會得到成功的 receipt。

### 3.5 轉帳（UI）

`server/transfer.ts` 的 plan 狀態機，每一步都是獨立狀態；**授權與送出從不自動進行**（UI 只會自動做唯讀或驗證的動作：進入 Deploy 即規劃、貼上 Passkey 證明即驗證，都不簽、不送、不花 XPL）；同一 plan 一次只處理一個請求（並發的第二個回 409），所以同一簽章不會發出兩筆交易：

1. **Intent**：source、recipient、asset、amount、Passkey owner index（只接受 Passkey owner）；`intentHash` 綁定之後每一步。
2. **Preview**：live nonce、fees；fork 上 execution-only 模擬＋twin validation（FCL fallback gas）；顯示 manifest（chain、地址、資產、金額、費用、nonce）。量測用的 twin 至少注資到暫定 draft 的 prefund（2M verification gas 時的上限），避免 XPL 少的帳戶在量測時就 AA21；複製 deposit 的 synthetic funder 依 deposit 金額加上固定 gas 預算注資（`twinFunding`），deposit 再大也不會讓預覽因 funder 餘額不足而失敗；真實餘額之後以最終 op 的 reserve 檢查，並由 exact signed simulation 再驗一次。瀏覽器只接受與送出時相同 draft 的 preview 回應：preview 期間 intent 任何欄位被改，回應的 plan 立即 discard，不顯示。
3. **Sign**：challenge = `userOpHash`；經 bookmarklet（顯示該 hash 的 request code，在 keys.coinbase.com 產生證明後貼回）、extension bridge（`kind: userop`）或 Console helper 取得 assertion → 貼上即送驗證（不需另按按鈕；錯誤時欄位全選，可直接貼上覆蓋）→ 本機以該 owner index 的公鑰驗證 → 組 `SignatureWrapper`。簽章只在 sidecar RAM。UI 的 10 分鐘倒數是**本機有效期**（`PLAN_TTL_MS`）：到期只讓本機不再使用這份 plan，**不是鏈上撤銷或到期**，畫面明說。
4. **Signed simulation**：fork 上以 exact signed op 跑 `handleOps`；`UserOperationEvent.success` 與資產差額必須相符。registry 中**其他**資產也要原封不動（execution-only 模擬同樣檢查）：帳戶在其他 token 的餘額不得變動、也不得有從帳戶轉出的其他 token Transfer event，以免收款合約的 callback 藉舊 allowance 順手拉走例如 USDT0，而請求的轉帳本身看起來完全正確（`checkEffects`，`server/sim.ts`）。帳戶 native 扣款中可算作 prefund 的部分，由 signed op 的 `(callGasLimit + verificationGasLimit + preVerificationGas) × maxFeePerGas` 減去執行前 deposit 獨立算出（`walletPrefund`），絕不從觀察到的扣款反推；EntryPoint deposit 的終值也必須正好是執行前＋prefund − `actualGasCost`（`depositProblems`）。失敗可在新 block 重跑（resimulate），不會自動前進。
5. **Send**：確認 sheet 重述 manifest，需輸入金額 → `/api/transfer/send-request` 再讀 nonce、核對 intentHash → 瀏覽器以 EIP-1193 `eth_sendTransaction` 送出 sidecar 準備好的 `handleOps`（beneficiary＝gas wallet）→ `/api/transfer/wallet-result` 回報 rejected／hash／no-hash。每個簽章最多發一次 send request，只有錢包回報 rejected 才可再發。呼叫錢包前必須先寫入 tracking record 並讀回確認（部署步驟同理寫 `cbpr.deploy.v1`）；storage 無法寫入時不呼叫錢包，顯示 `storage.unavailable`。Track 已有 20 筆紀錄時不會為了騰出空間而刪掉舊紀錄（最舊的可能仍未定案，也是下一個 intent 的 gate 依據）：新紀錄不寫入、不呼叫錢包，顯示 `storage.full`，請使用者先移除已定案的紀錄。錢包明確拒絕（4001）或在詢問錢包前就取消時，這次嘗試寫入的那筆無 tx hash 紀錄會被收回——不論 sidecar 是否接受這次回報（RPC 切換後 plan 已轉 unknown、回報被拒，紀錄仍收回）；取消尚未被領取的 Terminal hand-off 也只收回該 hand-off 自己寫入的紀錄，被拒絕的送出不佔 20 筆名額；若同一 userOpHash 在這次之前已有紀錄（例如結果 unknown 的前一次嘗試），或紀錄已帶 tx hash，一律保留。瀏覽器附上它顯示的 network max fee（`shownMaxFeePerGas`）與網路上限（`shownNetworkMaxWei`＝gas limit × max fee）；send-request 重新讀取的 fee 上限，或重新模擬後的 gas limit × fee 上限，任一比顯示值高，就不發交易，回傳更新後的 plan（`tx: null`、`feeRaised`），畫面顯示新的上限，使用者再按一次 Send 確認。outer fee 不在 UserOp 內，所以簽章不變。錢包請求帶 `chainId`（Plasma 9745），錢包網路在檢查後被切走時由錢包拒絕，不會在別的鏈上送出。
6. **Track**：§3.7。
7. **Terminal hand-off（進階）**：`/api/transfer/handoff` 對 signed simulation 通過的 plan 發一次性代碼（2 分鐘，且不超過 plan 的 10 分鐘有效期；`claim` 兩個期限都檢查，plan 過期時未領取的 plan 直接作廢），使用者在自己的 Terminal 執行 `npm run signer -- send` 輸入代碼領取 signed op；領取一次即忘記，之後瀏覽器不能再送，追蹤走事件掃描。tracking record 讀回成功才顯示代碼；按 Discard 時先問 sidecar，代碼已被領取（`unknown`）就保留 record 繼續追蹤，未領取才一起刪除。沒有 browser wallet 時，Move 表單可以輸入 Terminal signer 的 gas wallet 公開地址（`npm run signer -- status` 印出的地址；不輸入任何金鑰）來完成 preview、簽署、signed simulation 與 hand-off；這份 plan 不能從頁面送出（送出鈕只在已連接的錢包正是 plan 的 gas wallet 時才可按）。Terminal 廣播被節點拒絕時只顯示固定的原因與 JSON-RPC code（`server/signer/broadcast.ts`），不轉述節點的錯誤文字：它可能回顯已簽署的交易或簽章。

### 3.6 費用顯示

| 項目 | 誰付 | 說明 |
|------|------|------|
| Outer gas | 使用者的 gas wallet（EIP-1193） | `handleOps` 交易本身的 gas × gasPrice |
| UserOp 成本 | Smart wallet（`paymasterAndData = 0x`） | EntryPoint v0.6：deposit 不足時，`validateUserOp` 由 wallet 餘額補足 `missingAccountFunds` 進 deposit；執行後的實際成本從 deposit 扣除、付給 beneficiary；未用完的 prefund 留在 wallet 的 deposit |
| Beneficiary | 預設為 gas wallet 自己 | 因此 gas wallet 會收到 UserOp 實際成本，部分抵銷 outer gas；UI 明示 |

UI 不把兩者加總成單一「手續費」，而是兩行分開顯示（`feeSummary`，`server/transfer.ts`）：network fee 在簽署前是上限、signed simulation 後是確切 gas limit；wallet prefund 單獨一行。

> **Update(2026-11-02)**：receipt 不再假設 beneficiary 就是付 network fee 的人。`server/track.ts` 從 mined `handleOps` 解碼 beneficiary，receipt 帶 `bundler`（外層 `tx.from`）與 `beneficiary`；`TrackStep.tsx` 分兩條顯示、不相加，只有兩者相等時加一句「同一個送出 bundle 的地址」，匯出 JSON 加 `networkFeePaidBy`／`walletFeePaidTo`（解碼不到為 null）。規則見 [`design-ui-ux-guidelines.md`](./design-ui-ux-guidelines.md) §13.4。

**Reserve**：`reserve = max(0, prefund − EntryPoint deposit)`；native 的可用額度＝餘額 − reserve，token 不受影響。超過可用額度的 intent 在 preview 被拒絕並說明。

### 3.7 追蹤與持久化

`server/track.ts` 無狀態：只需要瀏覽器保存的 record，因此頁面重新整理與 sidecar 重啟後都能繼續。每次追蹤先核對端點的 chainId 與 genesis（`verifyChain`），才讀事件、receipt 與 nonce：端點已改答其他鏈（例如同一 URL 的自訂節點換了網路）時拋錯，record 維持未定案、不能移除。成功的定義：mined 的 `handleOps` 含**完全相同 userOpHash** 的 op、其 callData 解碼後的 source／asset／amount 等於 record，且收款地址的 `keccak256` 等於 record 的 `recipientHash`、`UserOperationEvent.success`；receipt 上的收款地址取自解碼後的 mined op。finality 是 registry 的確認深度（12）且 block hash 仍在 canonical chain。token 轉帳只比對該 op 自己執行區間內的 Transfer log（前一個 `UserOperationEvent` 或 `BeforeExecution` 之後、自己的 `UserOperationEvent` 之前），同一 bundle 中同一錢包的其他 op 不影響判定。狀態：`pending`、`unknown`、`mismatch`、`reverted`、`inner-failed`、`confirmed`、`final`、`reorged`。沒有 hash、hash 消失、事件掃描不完整都維持 `unknown`／`pending` 並附原因（回報的外層交易已 revert 或不含此 op 時也一樣：事件掃描完成之前，轉帳本身回 `unknown` 並在說明中註明外層交易的狀態，不顯示為失敗），掃描從 cursor 續做（每 chunk ≤ 2000 blocks、每次呼叫 ≤ 25 chunks）—— unknown 永不等於 failure。回報的 tx 若是 `reverted`、`mismatch` 或尚未上鏈的 `pending`，tracker 仍會掃描事件（略過該 tx；`pending` 只有在有界掃描找不到已驗證的執行時才回報），以免同一份 signed op 已由另一筆 tx 成功執行；找到時回報該結果並註明「由另一筆交易帶上鏈」，頁面把這個已驗證的 hash 寫回 record。sidecar 與 Terminal signer 都以 `buildTrackRecord` 產生 record。事件掃描與 nonce 讀取必須描述同一條鏈：讀完 nonce 後再讀一次查詢起點那個 head block 的 hash，若已被換掉（reorg），本次不下任何結論，回 `unknown`、掃描標為未完成，並從本次起點往回 64 個 block（不早於掃描下限）重掃，以免「掃描沒看到事件＋另一條分支上 nonce 已前進」被誤判為「此 op 沒有執行」。掃描下限是 `fromBlock − 64`（send-request 時的 head 往回 64 個 block，最低 0）而不是 `fromBlock` 本身：首次輪詢前的短 reorg 可能把 op 放進高度低於 `fromBlock` 的替換 block，若從 `fromBlock` 起掃，會看不到事件、只看到 nonce 已前進而誤判「沒有執行」。掃描完成後，下一次的起點存為 `scanCursor`（head − 64 blocks 的 reorg 重疊），重新整理也不必從 `fromBlock` 重掃。UI 只在結果不會再變時停止輪詢，也只有這時才提供「從清單移除」（未定案的 record 仍參與新 intent 的 gate，不能被移除繞過）（`src/ui/trackPoll.ts`）：`final`；深度已達 finality 的 `inner-failed`；深度已達 finality、帳戶 nonce **在 finality 深度上**（`nonceFinal`）已超過該 op、且事件掃描已完成的 `reverted`；以及被取代的 `unknown`（掃描完整、沒有這個 op 的 event、`nonceFinal` 已超過該 op：這份 op 再也不能執行）；較淺的失敗、只在淺層 block 被用掉的 nonce仍可能被 reorg 掉、同一份 signed op 重新上鏈，所以繼續追蹤。新 intent 的開放條件（`newIntentGate`，同檔）：同一帳戶的每一筆舊 record 都必須已對帳——op 已執行（`executed`）、live nonce 仍等於 op 的 nonce（`same-nonce`），或 nonce 已前進且掃描完整（`nonce-used`）；否則（尚無結果、nonce 讀不到、nonce 前進但掃描未完成）Move 表單、「新的轉帳」與「另開一筆獨立的新轉帳」都停用並說明原因。同 nonce 的保證文字只在 `same-nonce` 時顯示。gate 是較舊的觀察，preview 讀到的 nonce 是較新的：plan 的 nonce 必須與每筆舊 record 的 gate 一致（`nonceAgrees`：`same-nonce` 須相等，`executed`／`nonce-used` 須大於，`unknown` 一律不符），否則該 preview 不被接受、畫面上的未送出 plan 也立即捨棄，等 Track 跟上後再檢查。作廢的 plan 不會因在途回應而復活；send-request 在途時作廢，回應到達後不詢問錢包、先回報「未送出」再 discard；錢包一旦被詢問，plan 不再從頁面作廢，結果交給 Track。RPC 的 Re-check／Use／Clear 一按下就作廢頁面上未送出的 plan（sidecar 在回應前就已切換或重新 pin，所以不等回應，也不依賴 RPC sheet 是否仍開著；回應由 App 套用）。Move 步驟卸載（RPC 切換、從 Track 另開新轉帳）時，所有在途回應一律視為作廢，同樣不詢問錢包；這個檢查一直延伸到錢包 adapter 的 account／chain 預檢之後、`eth_sendTransaction` 之前。RPC 切換後的提示不宣稱「沒有送出任何東西」：它作廢頁面上的 plan，但錢包已送出的交易不會因此撤回，提示引導到 Track 與重新檢查帳戶。

`localStorage` 有兩個固定 key，只由 `src/ui/trackingStore.ts` 讀寫，讀寫都過同一份 allowlist：

| Key | 內容 |
|-----|------|
| `cbpr.tracking.v1` | 轉帳 record：userOpHash、nonce、資產與金額、inputHash、txHash、fromBlock、`scanCursor`；sender 與收款地址只存 keccak256 digest（`senderHash`／`recipientHash`）與縮寫（前 6／後 6 hex），gas wallet 只存 `gasWalletHash`。以 `userOpHash` 去重。舊格式（完整地址）在讀取時轉換並立即回寫 |
| `cbpr.deploy.v1` | 每個帳戶最多一筆進行中的部署送出：`accountHash`、`gasWalletHash`、步驟 key、txHash（可為 null）。沒有進行中的送出時 key 會移除 |

tracker 讀 EntryPoint nonce 與 gas wallet tx nonce 需要完整地址：輪詢時頁面把目前正在檢查的帳戶與已連線的 gas wallet 當作 hint 附上，只在 digest 與 record 相符時才附；sidecar 也會再驗一次，不符回 400。沒有 hint 時 sender 取自 mined op；兩者都沒有時 `nonceNow` 為 null，不判定「nonce 已前進」。tracker 另回 `nonceFinal`（head − finality depth 那個 block 上的 nonce），`reverted` 是否定案只看它，並提示回到步驟 1 檢查此錢包。永不持久化：assertion、signature、signed UserOp、RPC URL。重新整理後只能**追蹤**，不能重送。

### 3.8 i18n

字串表 `src/ui/copy.ts`（`en` 預設、`zh-Hant-TW`），兩語 key 完全一致（`test/unit/ui/i18n.test.ts`）；切換語言只改顯示，不改 intent。數字一律顯示完整精度與單位；地址顯示 checksum 全文並以 4 字一組輔助比對。UI 規格見 `design-ui-ux-guidelines.md`。

### 3.9 API（sidecar）

`server/sidecar.ts`，全部 POST，沿用 `server/http.ts` 的 guard（Host／Origin／session token），只綁 127.0.0.1。

| Path | 說明 |
|------|------|
| `/api/config` | mode、遮罩後的 upstream、deployment |
| `/api/rpc/{state,test,use,clear,probe}` | 自訂 RPC（M1）；回應只含遮罩形式 |
| `/api/diagnose` | `{account, evidence?}` → D1–D6；`evidence` 是 `{owners, nonce}`、`{calldata}`（createAccount calldata）或 `{initCode}`（factory ‖ calldata）三選一 |
| `/api/deploy/plan`、`/api/deploy/track` | 部署 plan；以 tx hash 驗證單一步驟 |
| `/api/transfer/{preview,signature,resimulate,send-request,wallet-result,discard,handoff}` | §3.5 |
| `/api/track` | 無狀態追蹤（§3.7） |
| `/api/deploy/{issue,send,abort}`、`/api/transfer/{relay,signer-aborted}`、`/api/gas/changed` | op／File payer 的 exact-tx issue 與 relay、payer 變動作廢（§8） |
| `/api/hello`、`/api/pair` | runner 的版本／能力與網站配對（[`5-hosted-local-runner.md`](./5-hosted-local-runner.md) §3） |

> **Update(2026-11-02)**：sidecar 也以真實路徑提供頁面（`/`、`/recover`、`/guide`、`/how-it-works`、`/security`、`/download`；其他像 document 的 GET 回 404 頁），分類在 `server/staticRoute.ts`。每個請求在 URL 解析與上表 API 分派之前先驗 raw path，不合格回 400；`Sec-Purpose`／`Purpose: prefetch` 回 503；上表 API 與 guard 不變。規則見 [`design-ui-ux-guidelines.md`](./design-ui-ux-guidelines.md) §13.3。

沒有任何 sidecar 端點接受私鑰（op／File 的密碼與 1Password link 只送到隔離的 signer child，[`5-hosted-local-runner.md`](./5-hosted-local-runner.md) §5）；唯一會廣播的是上列 relay，且只送 sidecar 自己 issue、驗證通過的 raw tx；AI report 在瀏覽器端由 allowlist 組成（`src/ui/report.ts`），不經 sidecar。

### 3.10 Source-scan exemptions

`test/unit/source-scan.test.ts` 禁止 `src/` 出現 Web Storage、IndexedDB、cookie、送交易、wallet RPC、訊息簽署、遠端 script／style、動態程式碼、URL state。M4 只開三個例外，每個只限一個檔案、且該檔案內每個匹配都必須落在允許的形式裡：

| 能力 | 唯一檔案 | 允許形式 |
|------|----------|----------|
| Web Storage | `src/ui/trackingStore.ts` | `localStorage`（固定 key `cbpr.tracking.v1` 與 `cbpr.deploy.v1`）；不准 `sessionStorage` |
| 送交易 | `src/wallet/eip1193.ts` | `'eth_sendTransaction'`（sidecar 準備好的交易） |
| Wallet RPC | `src/wallet/eip1193.ts` | `'wallet_switchEthereumChain'`、`'wallet_addEthereumChain'` |

訊息簽署（`eth_sign*`、`personal_sign`、`signTypedData`）沒有任何例外。每個例外都有雙向對照（違規範例必須被抓到、合法用法必須通過）與「例外檔案仍存在」檢查。

> **Update(2026-11-02)**：新增第四個例外。**URL state** 只限 `src/ui/site/router.ts`，只准兩種形式：`history.pushState(null, '', url.pathname + url.search + url.hash)`（使用者點的同 origin 頁面連結本身）與 `history.replaceState(history.state, '', path + location.search)`（把認得的舊 `#/…` 換成對應路徑）。不准指定 `location.hash`／`location.search`，也不准把其他值寫進 URL；雙向對照在同一個測試檔。

### 3.11 發布決策（2026-10-31，使用者決定）

| 項目 | 決定 |
|------|------|
| 授權 | Apache-2.0，只適用自有程式；第三方內容（字型、合約 bytecode、依賴）沿用各自授權，見 `THIRD_PARTY_NOTICES.md` |
| Repo | `github.com/sd0xdev/passkey-recovery`（發布前重新確認名稱與帳號） |
| 官網 | Cloudflare Workers Static Assets、先用 workers.dev；正式網域未定 |
| 發布方式 | 明確 allowlist，永不 `git add .`；公開去個人化的 registry，public code／tests 不依賴私有研究資料 |

## 4. Risks and Dependencies

| 風險 | 影響 | 緩解 |
|------|------|------|
| 免 Console 路徑全部 no-go | G2 無法達成 | Console 保留為進階流程；官網誠實說明 |
| Extension 供應鏈遭竄改 | 惡意版本取得 assertion | 最小權限、可重現建置、hash 公告、配對、assertion 綁定 intent |
| 公開 RPC rate limit／無 fork 能力 | 無法模擬 | 自訂 RPC；模擬失敗即不可簽 |
| 使用者在錯的 chain 簽署 | 資產移動錯誤 | userOpHash 含 chainId；D1 檢查；確認畫面顯示 chain |
| EIP-1193 錢包替換 tx | 送出內容不同 | 追蹤以 op 為準（§3.7）：mined op 的 userOpHash、解碼後 intent 與 nonce 必須與 record 相符，否則 `mismatch`；外層 gas 上限高於畫面所示時 send-request 拒絕 |
| Reorg | confirmed 被撤回 | 依確認數顯示；`3-architecture.md` §5.3 |
| 誤導性宣稱 | 法律與信任風險 | 文案檢查清單（`4-open-source-and-website.md` §5.5） |
| 依賴：anvil（Foundry） | 安裝門檻 | README 標明版本；無 anvil 時不可簽 |
| 本機 DNS fake-IP（198.18.0.0/15） | 公開 RPC 被 SSRF guard 拒絕 | 依設計不放寬；改用不經 fake-IP 的網路或自訂 RPC |

## 5. Work Breakdown

| M | 內容 | 前置 | 狀態 |
|---|------|------|------|
| M0 | 規劃文件、回顧紀錄 | — | ✅ |
| M1 | RPC 層：capability probe、自訂 RPC session、SSRF guard、切換作廢 | M0 | ✅ |
| M2 | ADR-001 spikes S1–S4 → ADR-002；extension bridge＋本機 proof harness | M0 | ✅（真實 passkey 層待手動） |
| M3 | Intent／診斷／部署／轉帳／追蹤參數化（移除固定值），保留全部關卡；bridge `userop` kind 接到轉帳簽署 | M1、M2 | ✅ |
| M4 | UI 重做（design guidelines、Logbook）、en 預設＋繁中、redacted report、AI runbook 實作；地址輸入見下 | M3 | ✅（VoiceOver 待手動） |
| M5 | 開源準備（Apache-2.0、secret scan、CI、社群文件、extension 可重現建置與 hash 公告）；公開 repo `sd0xdev/passkey-recovery` 與官網另開 release run | M4 | ⏳ |

**M4 地址輸入**：允許貼上 42 字元地址（不強迫手打），必須 EIP-55 檢查；recipient 輸入兩次，任一欄是貼上的，都必須勾選「已用獨立來源核對」（勾選只對當下那個地址有效，任一欄再編輯就清除）（例如另一裝置上的錢包、區塊瀏覽器、原始紀錄）才可 Review；UI 以 4 字一組顯示供逐組比對。

**開源前**：研究原始資料（research raw evidence、spike 原始輸出）必須排除或 redacted；發佈只挑明確檔案，**永不 `git add .`**。

## 6. Testing Strategy

| 層 | 內容 | 命令 |
|----|------|------|
| Unit | intent、WebAuthn／proof、signature、derive、guard、registry、redactor、tracking store、i18n、source scan | `npm run test` |
| Integration（anvil testchain） | 空鏈逐步部署；兩個 synthetic accounts（不同 owner index）上 nonce 0、1、2；fees／reserve；全部中斷；Terminal hand-off；RPC 切換作廢 | `npm run test:integration` |
| E2E（Playwright＋axe） | 4174 靜態 build（無 sidecar 狀態、headers）；4175 testchain sidecar（空鏈，經 mock EIP-1193 錢包部署）；4176 synthetic custom provider（`/rpc`、`/other`、`/hits`、`/world`）。完整流程、proof、RPC、helper、axe／鍵盤／reduced motion；`E2E_SHOT_DIR` 時存截圖 | `npm run test:e2e` |
| Live（手動） | 公開 RPC 唯讀 | `npm run test:live` |

Assertion 一律在 Node 以 throwaway fixture key 產生；沒有真實 Passkey、真實錢包或網路。

## 7. Open Questions

1. ~~ADR-001 spike 結果~~ → ADR-002（2026-10-31）。剩餘：真實 OS passkey 驗證、extension 發佈通道（商店或側載）與商店簽章下的 ID。
2. ~~授權條款~~ → Apache-2.0（品牌 Passkey Recovery by sd0x）。
3. ~~是否保留 Terminal signer~~ → 保留為進階 hand-off（§3.5 第 7 步）。
4. ~~支援 allowlist 的第二組 chain~~ → 不在本次交付範圍（使用者 2026-10-31：只支援 Plasma 9745）。
5. ~~官網託管~~ → Workers Static Assets（§3.11）；正式網域未定。

## 8. Hosted／Local 統一產品（2026-11-01）

同一份 UI 的兩種部署（本機 runner 與靜態網站）、配對、三種 gas 錢包、secret 邊界、威脅模型與 release matrix 的規格在 [`5-hosted-local-runner.md`](./5-hosted-local-runner.md)；決策見 [ADR-003](./adr-003-local-runner-pairing.md)、[ADR-004](./adr-004-bookmarklet.md)；INV-005 的 2026-11-01 amendment 見 [intent](./intent-open-source-recovery.md)。本 spec §3.5 的「送出只經使用者的 EIP-1193 錢包」因此擴充為：瀏覽器錢包、瀏覽器 File、runner 的 native signer（native File／1Password），以及原有的 Terminal hand-off；sidecar 仍不持有金鑰，只轉送它驗證過、與它 issue 的 exact tx 完全相同的 signed tx（`server/relay.ts`）。
