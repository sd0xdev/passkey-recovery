# Requirements: Passkey Recovery by sd0x（開源版）

> **Doc class**: Lifecycle — Phase 1 requirements（per `@rules/docs-numbering.md`）。Feature-level problem-space analysis。**不是** task tracking ticket。
> **Created**: 2026-10-31
> **Updated**: 2026-11-01（G3、FR-4、FR-14、UC-8、§9 依 unified-product mission 更新；現行驗收依據為 request 2026-11-01（`requests/2026-11-01-unified-hosted-local-gas-wallets.md`，私人紀錄，不公開） 的 GAS／HOST／NX AC）
> **Tier**: deep
> **Tech Spec**: [Link](./2-tech-spec.md)

## 1. Problem Statement

原本的單一 case 工具（維護者的私人紀錄，不公開）成功救回了一個特定錢包的兩筆指定金額（1 XPL、1 USDT0），但它是為**單一 case**打造：固定 WALLET、固定 recipient、固定金額、固定 nonce 0/1、私有 RPC 檔、只能在 Terminal 簽署廣播、要在 keys.coinbase.com 的 DevTools Console 貼 helper。其他遇到同樣處境的人無法安全地重用它，而「到別人網站的 Console 貼程式碼」本身就是 self-XSS 的典型詐騙話術，不能當成大眾流程。

### 5-Why Trace

1. Surface：使用者要「開源、不用 DevTools Console、在 UI 部署與轉帳、預設公開 RPC、可自訂 RPC、全新 UI、完整文件與 AI 協作流程、註明作者、規劃官網」。
2. Why：同類使用者（Coinbase Smart Wallet 在某條 chain 未部署、資產在 counterfactual address 上）需要一條自己能走完、看得懂、不必信任第三方的救援路徑。
3. Root：成功標準是「本人在可驗證的開源工具裡，對自己的 intent 做出每一次簽署與送出決定」，且工具不讓任何人（包含作者、AI、其他網站）有機會代簽、代送或取得秘密。

## 2. Goals / Non-Goals

| Goals | Non-Goals |
|-------|-----------|
| G1 per-user 不可變 intent（wallet、recipient、asset、amount、nonce） | 本階段寫產品 code 或改 `src/`、`server/`、`test/`（規劃階段；已由 2026-10-31 M3／M4 授權取代） |
| G2 不需 DevTools Console 的 Passkey 簽署路徑（或在證明不可行前，明確標示為進階手動流程） | 放寬現行 case 的固定限制 |
| G3 UI 內部署：使用者自己的 gas wallet 逐步確認 —— EIP-1193 瀏覽器錢包、File keystore 或 1Password（2026-11-01 起三種皆必需） | 代管金鑰、custodial relayer、任何網站都能呼叫的 localhost 廣播 API（配對後只轉送 runner 自己 issue、驗證過的 exact tx 是允許的，見 FR-14） |
| G4 UI 內轉帳：預覽、簽署、送出、追蹤各自分開 | 宣稱支援任何錢包／保證成功／已稽核 |
| G5 公開 RPC 為預設，UI 可輸入自訂 RPC（session-only） | 承諾公開 RPC 永遠支援 historical fork |
| G6 全新 UI（frontend-design skill、參考 iOS 27 Liquid Glass），英文預設＋繁中切換 | 複製 Apple 或 Coinbase 的商標視覺 |
| G7 完整文件、AI 協作 runbook（AI 只讀與提案） | 讓救援依賴 Claude／Codex／sd0x-harness |
| G8 開源與官網規劃、作者 credit、非官方聲明 | 本階段建 public repo、部署官網（授權條款已決定：Apache-2.0，見 §9） |
| G9 永久的救援回顧紀錄 | 修改原始研究證據 |

## 3. Stakeholders

| Stakeholder | Role | Key Concern |
|-------------|------|-------------|
| 救援使用者 | User | 資產安全、看得懂每一步、不被騙去貼 Console |
| 維護者（sd0x，GitHub `sd0xdev`） | Developer / Operator | 可重現建置、供應鏈、責任邊界、credit |
| 貢獻者 | Developer | 清楚的架構與測試、社群規範 |
| AI 協作代理（Claude／Codex） | Dependent（dev workflow） | 只拿到 redacted 資料、知道哪些動作是禁止的 |
| Coinbase／keys.coinbase.com | External RP | 工具不得冒充、不得繞過 origin 檢查 |
| Plasma 公開 RPC 營運方 | External | rate limit；「not for production systems」 |

## 4. Use Cases

| # | Actor | Action | Expected Outcome |
|---|-------|--------|-----------------|
| UC-1 | User | 貼上自己的 wallet address，在 Plasma（9745）上診斷 | 看到 deployed／counterfactual、版本、owner、資產、可救援性，不支援時明確說明原因 |
| UC-2 | User | 以自己的 EIP-1193 錢包部署缺少的 infra 與 wallet | 每一步預覽 gas 與 calldata、逐步確認，完成後 code hash 與 owner 驗證通過 |
| UC-3 | User | 建立轉帳 intent、預覽、以 Passkey 簽署、確認送出 | 送出前看到 exact chain／address／asset／amount／fees／nonce；送出後先 pending，再 confirmed 或 inner-failed |
| UC-4 | User | 關閉分頁後回來 | 從 redacted receipt 摘要恢復追蹤，不重送 |
| UC-5 | User | 改用自己的 RPC | 輸入、遮罩、測試連線、清除；capability probe 結果可見 |
| UC-6 | Contributor | 依 README 重現建置並跑測試 | 全部測試在 synthetic testchain 通過，無需任何真實秘密 |
| UC-7 | User + AI | 把 redacted status report 交給 AI 求助 | AI 回 action proposal；簽署與送出仍只能由本人在 UI 完成 |
| UC-8 | Visitor | 瀏覽官網 | 理解適用範圍、限制、非官方聲明、GitHub 連結；官網不收 seed／key；不自動探測 localhost，只在使用者自行啟動 runner 並明確觸發配對後才連本機（2026-11-01，[`5-hosted-local-runner.md`](./5-hosted-local-runner.md)） |

## 5. Functional Requirements

| ID | Requirement | Priority | Rationale |
|----|-------------|----------|-----------|
| FR-1 | Intent 由使用者輸入 source wallet、recipient、asset、amount；nonce 由 live read 取得；任何欄位變更即作廢先前的預覽與簽章 | Must | INV-001 |
| FR-2 | 診斷支援的組合以 allowlist 表達（wallet 版本 × chain × EntryPoint）；首版 allowlist 只有 Coinbase Smart Wallet v1.1 × Plasma 9745，不在 allowlist 一律 fail closed 並說明 | Must | INV-002 |
| FR-3 | Counterfactual address 推導（factory `getAddress(owners, nonce)`）必須與使用者輸入的 wallet 一致，owner 順序保留 | Must | 防止部署到錯的地址 |
| FR-4 | 部署為多步驟，每步由使用者選定的 gas wallet（EIP-1193、File 或 1Password）確認；deterministic deployment 的 bytecode 以 hash pin | Must | G3、保留現有安全性 |
| FR-5 | 轉帳簽署前必須完成 unsigned 預覽；簽署後送出前必須完成 exact signed local fork simulation | Must | 現有 gate 保留 |
| FR-6 | 送出後分別判定 outer receipt 與 `UserOperationEvent.success`；native 與 ERC-20 以不同證據確認 | Must | INV-003 |
| FR-7 | Pending 交易先追蹤、不重送；重新整理後從 redacted 摘要恢復 | Must | INV-006 |
| FR-8 | 預設公開 RPC；自訂 RPC 只存 session 記憶體、遮罩、可測試與清除 | Must | G5、INV-007 |
| FR-9 | RPC capability probe（read／estimate／fork／archive；broadcast 永遠標示 not-probed，不送測試交易）。實際送出有兩條路：瀏覽器錢包（EIP-1193）自己廣播；File／native payer 的已簽交易經 runner 驗證後 relay（FR-14）與 rate limit／錯誤處理、fallback、同 chain 同 snapshot 一致性 | Must | 公開 RPC 是正式功能 |
| FR-10 | 不使用 DevTools Console 的 Passkey 簽署路徑；在 spike 證實前，Console helper 只能以「進階手動流程」呈現並附 self-XSS 警告 | Must | G2；見 ADR-001 |
| FR-11 | 顯示 EntryPoint deposit 與 gas wallet 外層費用的差異 | Must | 使用者常混淆兩者 |
| FR-12 | 英文預設、繁中切換；財務確認元件雙語一致 | Must | G6 |
| FR-13 | Redacted status report 匯出（供人或 AI 閱讀） | Should | G7 |
| FR-14 | 本機 runner 的 native signer（native File／1Password），以及 File／native payer 的驗證後 relay | Must（2026-11-01 取代原 Could／optional） | 隔離的 signer 子程序；只接受 runner 自己的頁面與 exact-origin allowlist 中、輸入一次性配對代碼的網站；只簽 sidecar issue 的 exact tx；仍禁止任意網站呼叫與任意廣播（GAS-03／05、HOST-03／05） |
| FR-15 | MCP server 只讀與提案 | Could | G7；永不簽署或送出 |
| FR-16 | 官網：IA、真實文案、GitHub 與 harness 連結、產品驗證狀態（不含原案例的 tx／地址，見 `4-open-source-and-website.md` §5.4）、非官方聲明 | Should | G8 |

## 6. Non-Functional Requirements

| ID | Category | Requirement | Metric |
|----|----------|-------------|--------|
| NFR-1 | Security | 秘密不外洩 | log／URL／storage／export／bundle 掃描對 assertion、signed UserOp、RPC secret pattern 命中數 = 0 |
| NFR-2 | Security | SSRF 防護 | 自訂 RPC 指向 private／loopback／link-local 位址時，未開自架例外前 100% 拒絕；redirect 不跟隨 |
| NFR-3 | Usability | 財務確認可讀 | 確認畫面列出 7 個綁定欄位（chain、from、to、asset、amount、UserOp fee 上限、nonce；UserOp fee 上限由簽章綁定，gas wallet 的 outer network fee 另列並標示為估計值），全部可見、不截斷關鍵位元 |
| NFR-4 | Accessibility | WCAG 2.2 AA | 文字對比 ≥ 4.5:1、焦點可見、全鍵盤可操作、reduced motion／reduced transparency 生效 |
| NFR-5 | Reliability | 公開 RPC 故障 | rate limit 時指數退避，最多 3 次，之後明確提示改用自訂 RPC；不靜默失敗 |
| NFR-6 | Maintainability | 可重現建置 | 乾淨機器依 README 安裝並跑完 unit／integration 測試，不需真實秘密 |
| NFR-7 | Supply chain | 依賴可審 | lockfile pinned、`npm audit` 無 high／critical、第三方授權清單完整 |

## 7. Constraints & Assumptions

| Type | Description | Source |
|------|-------------|--------|
| Constraint | WebAuthn RP ID 必須是呼叫者 origin 的 registrable domain suffix；localhost 只能用 RP ID `localhost` | W3C WebAuthn L3 REC（2026-08-25）§ RP ID |
| Constraint | Related Origins 只能由 RP（keys.coinbase.com）擁有者開啟；目前檔案只列 `https://tba-web-dev.cbhq.net` 且為 text/plain | 2026-10-31 實際讀取 |
| Constraint | `validateUserOp` 驗 raw userOpHash；ERC-1271 驗 `replaySafeHash(hash)`，兩者不可互換 | coinbase/smart-wallet v1.1.0 `CoinbaseSmartWallet.sol` L191／L342、`ERC1271.sol` L70 |
| Constraint | 官方公開 RPC `https://rpc.plasma.to` 標示「Rate limited and not for production systems」 | Plasma docs（2026-10-31） |
| Constraint | EIP-5792 calls 只有 `{to, data, value}`，dapp 無法指定 nonce／gas／userOpHash | EIP-5792（Final） |
| Assumption | 使用者仍可在 keys.coinbase.com 使用自己的 Passkey | 本 case 實際完成兩筆簽署 |
| Assumption | 公開 RPC 目前回應 historical state（block 1 的 `eth_getBalance`） | 2026-10-31 單次探測，非保證 |
| Assumption | 依賴為 MIT／Apache-2.0 | `node_modules` license 欄位讀取（2026-10-31） |

## 8. Acceptance Signals

- FR-1／FR-6／FR-7：synthetic testchain e2e 走完 UC-3 與 UC-4，含 inner-failed 與 reload-pending 兩條分支。
- FR-2／FR-3：unit 測試對 unknown version、wrong chain、owner 順序顛倒、推導不一致各自 fail closed。
- FR-5：integration 測試以 twin 讀自己 nonce，覆蓋 nonce 0、1、>1、完成一筆後再做一筆。
- FR-8／NFR-1／NFR-2：自訂 RPC e2e（遮罩、清除、重新整理後消失）＋ SSRF 單元測試＋掃描報告。
- FR-10：ADR-001 的 spike 結果記錄 go／no-go；未 go 前 UI 不出現「免 Console」宣稱。
- NFR-4：axe 掃描 0 個 serious／critical，鍵盤走完整條救援流程。

## 9. Open Questions

- [ ] 免 Console 的簽署路徑哪一條可行？（ADR-001 spikes S1–S4）
- [x] 授權條款：Apache-2.0（2026-10-31，使用者決定；見 [`4-open-source-and-website.md`](./4-open-source-and-website.md) §1）。
- [x] 支援範圍：首版只支援 Coinbase Smart Wallet v1.1 × Plasma mainnet（9745）（2026-10-31，使用者：「只需要先支持 plasma 就好了」）。其他鏈的相容性開發、測試與發布宣稱不在範圍內，不列為待辦或 release gate；匯入其他鏈上的原始部署證據只用來核對 Plasma 上的地址推導。
- [ ] 官網網域（託管已決定：Cloudflare Workers Static Assets，先用 workers.dev）。
- [x] 本機 signer（FR-14）：維護，且三種 payer 皆必需（2026-11-01，使用者於 unified-product mission 決定）。Terminal signer 保留為 hand-off 路徑。

## 10. References

- Tech Spec: [Link](./2-tech-spec.md)
- Feasibility: [0-feasibility-study.md](./0-feasibility-study.md)、[adr-001-no-console-signing.md](./adr-001-no-console-signing.md)
- 原 case：維護者的私人紀錄（不在公開 repo）
- 回顧：維護者私人紀錄（不公開）
