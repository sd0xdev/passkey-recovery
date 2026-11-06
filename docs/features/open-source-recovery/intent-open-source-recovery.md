# Intent — open-source-recovery（Passkey Recovery by sd0x）

> **Doc class**: Intent (ancillary — Design record)。由 planner 撰寫、implementer 檢查。任何工作與下列 Invariant 或 Non-goal 衝突即停下來詢問 —— 修改本檔是重新決策，不是同步。

## North star

讓一位遺失 Coinbase Smart Wallet 前端、但仍持有自己 Passkey 的使用者，不必打開 DevTools Console、不必信任任何代管服務，就能在一個開源、可重現建置的 UI 裡診斷自己的錢包、部署缺少的合約，並把**自己指定**的資產轉到**自己指定**的地址 —— 每一次簽署與送出都由本人在畫面上確認。

## Non-goals

- 本階段不寫產品 code、不改 `src/`、`server/`、`test/`，也不放寬現行 case 的固定限制（固定 WALLET／recipient／金額／nonce 0/1 仍是現行實作的事實）。
- 不把原 case（單一錢包、兩筆 1 XPL／1 USDT0）的授權擴寫成通用授權；新 feature 必須自己取得每位使用者的 intent。
- 不代管、不保存任何私鑰、seed、Passkey 憑證或 RPC secret；不做 custodial relayer。
- 不關閉 origin 檢查、不攔截他人 Passkey、不匯出憑證、不冒充 Coinbase。
- 不宣稱「支援任何錢包」「保證成功」「已完整稽核」；不宣稱已開源或已部署。
- 官網不收集 seed／key，也不從官網暗中呼叫 localhost。
- AI（Claude／Codex／MCP）不簽署、不送出；使用者救援不得依賴 AI 或 sd0x-harness。

## Invariants

- `INV-001`: 每一筆資產移動都綁定一份不可變 intent（chainId、source wallet、recipient、asset、amount、UserOp fees 上限、nonce），任何欄位改變即作廢，需重新預覽與重新簽署。
- `INV-002`: 未知或不支援的 wallet 版本、chain、code hash、owner 或 counterfactual address 推導不一致時 fail closed —— 不顯示可簽狀態。
- `INV-003`: 簽署與送出各自是一次獨立、明確、由本人觸發的動作；模擬成功 ≠ 主網成功；outer receipt success ≠ inner `UserOperationEvent.success`。
- `INV-004`: raw assertion、signed UserOp、私鑰、密碼、RPC secret 永不進入 log、URL、localStorage、匯出檔、git 或 AI context；簽章只存在 RAM。
- `INV-005`: 不存在「任何網站都能呼叫、持有金鑰的 localhost 廣播 API」；部署 gas 由使用者自己的 EIP-1193 錢包逐步確認支付。
  - **Amendment 2026-11-01**（使用者於 unified-product mission 決定，[ADR-003](./adr-003-local-runner-pairing.md)）：gas 也可以由使用者自己的 File keystore 或 1Password item 支付。持有金鑰的只有 (a) 瀏覽器 File 的分頁記憶體，或 (b) 使用者自行啟動的本機 runner 的 signer 子程序；後者只接受 runner 自己的 localhost 頁面，以及 exact allowlist 中、輸入一次性配對代碼的網站 origin，並且只簽 sidecar 發出、使用者已確認的 exact tx。「任何網站都能呼叫」仍然禁止；每一步仍由本人確認並看到完整付款地址。
- `INV-006`: Pending 的交易先追蹤、後決策，永不靜默重送；nonce 每次送出前重新讀取（fresh），twin 模擬讀自己的 nonce。
- `INV-007`: 自訂 RPC 只存在本次 session 記憶體，遮罩顯示；對 private network／localhost 的連線要明確的自架節點例外。

## Acceptance sketch

在一台乾淨機器上依 README 重現建置。兩個環境分開驗收：(a) 以公開 RPC（Plasma 主網，唯讀）開啟 UI，只做 capability 與唯讀檢查，不部署、不送出；(b) 在本機 synthetic testchain（anvil，`CBPR_TESTCHAIN_RPC`，見 `test/support/e2e-servers.ts`）上走完整流程：輸入一個 synthetic testchain 錢包 → 診斷顯示「未部署、owner 與推導一致」→ 以使用者自己的 EIP-1193 測試錢包逐步確認三個部署步驟 → 建立一筆 intent 並在預覽頁看到精確 chain／地址／資產／金額／費用／nonce → 簽署（不經 Console）→ 本人按下送出 → 畫面先顯示 pending，再依 receipt 與 `UserOperationEvent.success` 分別顯示 confirmed 或 inner-failed；整個過程的 log、URL、storage 掃描不含任何簽章或 secret。

## Status（2026-10-31，2026-11-01 更新）

- 第一條 Non-goal（「本階段不寫產品 code」）屬於規劃階段；使用者於 2026-10-31 的 M3／M4 run 授權實作，原 case 固定限制已移除並改為 per-user intent（M3／M4 request（`requests/2026-10-31-m3-m4-local-product.md`，私人紀錄，不公開））。其餘 Non-goals 與 INV-001～INV-007 不變。
- 2026-11-01：INV-005 依上方 amendment 擴充 gas 錢包來源；官網不暗中呼叫 localhost 的 Non-goal 不變（配對需使用者自行啟動 runner、同意瀏覽器提示並輸入代碼）。Hosted 網站尚未部署（request（`requests/2026-11-01-unified-hosted-local-gas-wallets.md`，私人紀錄，不公開））。
- 原 case 的授權沒有擴寫成通用授權：每一筆轉帳都由當次使用者輸入、預覽、簽署並親自送出。
