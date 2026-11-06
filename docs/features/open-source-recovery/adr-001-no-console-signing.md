# ADR-001: 免 DevTools Console 的 Passkey 簽署路徑

> **Status**: Accepted（2026-10-31，spike 完成）—— S2 go → [ADR-002](./adr-002-extension-bridge.md)；S1 技術可行但降為記錄在案的備案；S3 外部阻塞（不影響決策）；S4 no-go，正式關閉。證據：`requests/2026-10-31-m2-spike-results.md`（私人紀錄，不公開）。
> 下方 Decision 與「未驗證事項」保留提案時的原文；各項現況見末節「Spike 結果（2026-10-31）」。
> **Context doc**: [0-feasibility-study.md](./0-feasibility-study.md)

## Context

救援需要一個 WebAuthn assertion，RP ID 為 `keys.coinbase.com`，challenge 是我們預先建立的 raw `userOpHash`。WebAuthn 的 RP ID 規則讓本機工具不能直接呼叫，Related Origins 只能由 Coinbase 開啟（目前不包含我們），Coinbase SDK 的簽署方法走 ERC-1271 的 `replaySafeHash`，與 `validateUserOp` 驗的 raw hash 不同。現行唯一驗證可行的方法是在 keys.coinbase.com 的 DevTools Console 貼 helper。

## Decision（proposed）

1. **主要候選**：一個最小權限的 MV3 browser extension（`activeTab`＋`scripting`），只在使用者於 `https://keys.coinbase.com/connect` 點擊 extension 時，對 top frame 注入一次簽署函式，並把 assertion 經 extension 回給已配對的本機 UI。是否採用由 spike S2 決定。
2. **輕量備案**：bookmarklet（S1）。若 S2 no-go 而 S1 go，採用 bookmarklet，但 UI 必須把它與 Console 一樣標示為「在 Coinbase 頁面執行本工具提供的程式」，並顯示程式 hash 供比對。
3. **保留**：Console helper 繼續作為「進階手動流程」，預設收合，附 self-XSS 警告與 helper SHA-256。
4. **不採用**：直接本機呼叫、Related Origins、iframe、SDK `personal_sign`／`eth_signTypedData_v4`、SDK `wallet_prepareCalls`、跨鏈 nonce key 8453。
5. **不宣稱**：在任何 spike go 之前，產品、README 與官網都不得寫「不需要 Console」。

## Go／No-go

| Spike | Go → 動作 | No-go → 動作 |
|-------|-----------|--------------|
| S2 extension | 進入 extension 實作 spec（另開 ADR-002：權限、配對、發佈） | 檢查 S1 |
| S1 bookmarklet | 作為次要路徑實作 | 只保留 Console 進階流程，並在官網說明原因 |
| S3 SDK chain 9745 | 記錄；不改變決策（無法綁定 exact nonce／fees） | 記錄，正式關閉 |
| S4 `wallet_sign` raw hash | 重開本 ADR 比較 SDK 路徑 | 記錄，正式關閉 |

## Consequences

- 好處：使用者不必打開 DevTools；extension 能在注入前檢查 exact origin、top frame 與 path，比 Console 更難被誘導貼錯。
- 代價：extension 帶來供應鏈與更新風險、需要配對機制、行動裝置不保證；bookmarklet 與 Console 本質相同，只是降低操作門檻。
- 不變的事：簽章只存在 RAM；送出前仍需 exact signed local fork simulation；每次簽署綁定一份 intent 與到期時間。

## 未驗證事項（不可標為已驗證）

- 注入 MAIN world 的呼叫是否以 keys.coinbase.com 為 origin、extension 點擊是否滿足 user activation（F14）。
- Bookmarklet 在 keys.coinbase.com 的 CSP 下是否可執行。
- 行動瀏覽器的 extension 支援。
- Coinbase popup 對 chain 9745 與 `wallet_sign` 的行為。

## Spike 結果（2026-10-31）

| 原未驗證事項 | 現況 | 層 |
|--------------|------|----|
| MAIN world 注入的 origin、extension 點擊是否滿足 user activation（F14） | MAIN 與 ISOLATED 都以 keys.coinbase.com 為 origin；ISOLATED 採用。真實工具列點擊的 activation **仍未驗證** | virtual official-origin；真實層待 [checklist](./checklist-m2-manual-verification.md) |
| Bookmarklet 在 CSP 下是否可執行 | 可執行（`script-src 'unsafe-inline'`），但 `connect-src` 擋住回傳本機，只剩剪貼簿 | virtual official-origin |
| 行動瀏覽器的 extension 支援 | 未測，不宣稱 | — |
| Popup 對 chain 9745 與 `wallet_sign` 的行為 | 需真實帳號，外部阻塞；`wallet_sign` 由規格＋合約測試判定 no-go | source＋synthetic testchain |

Decision 5 修正：S2 在 virtual 層 go 之後，UI 可標示「預覽，免 Console」；**真實 passkey 層完成前**，README 與官網仍不得宣稱「不需要 Console」。
