# ADR-004：靜態 bookmarklet 作為免 extension、免 DevTools 的 Passkey 簽署路徑

> **Status**: Accepted（2026-11-01）—— virtual official-origin 層 3 次獨立執行皆通過；**真實 OS Passkey 與真實書籤列點擊尚未驗證**（使用者本人）。**Related**: [ADR-001](./adr-001-no-console-signing.md)（S1 spike）、[ADR-002](./adr-002-extension-bridge.md)（extension）、[ADR-003](./adr-003-local-runner-pairing.md)。

## Context

- Passkey 的 RP 是 `keys.coinbase.com`，assertion 只能在該 origin 產生。Extension（ADR-002）需要安裝且目前只認 4173；DevTools helper 每次都要貼程式碼，對一般使用者風險高。
- S1 spike：`keys.coinbase.com` 的 CSP `connect-src` 擋 loopback，所以本實作選擇讓結果經剪貼簿（被拒時以 prompt 顯示）由使用者貼回我們的頁面。

## Decision

1. **一份固定程式**（`src/webauthn/bookmarklet.ts`，`cbpr-bookmarklet-v1`）：每次請求都是同一段 code，sha256 固定（`BOOKMARKLET_SHA256`），可一次核對後存成書籤。
2. **輸入只有資料**：使用者在我們頁面複製 request CODE（`cbpr1:<proof|userop>:<32-byte challenge base64url>`），在 Coinbase 頁面點書籤後貼上；畸形 CODE 在呼叫 WebAuthn 前就拒絕。
3. **最小行為**：只呼叫 `navigator.credentials.get`；不連網、不碰 storage／cookie；非 `keys.coinbase.com` 拒絕；結果先寫剪貼簿，被拒時以 prompt 顯示一次；不 log、不留在頁面。
4. **我們的頁面照常驗證**：貼回的 assertion 以同一套 WebAuthn 驗證（challenge、origin、flags、owner 公鑰），不信任 bookmarklet 的任何宣稱。

## 證據分層

| 層 | 狀態 | 證據 |
|----|------|------|
| Unit（同一份 source 以 `javascript:` 方式執行） | ✅ 6 項 | `test/unit/webauthn/bookmarklet.test.ts` |
| Virtual official-origin（真實 `https://keys.coinbase.com/connect`、CSP 開、CDP virtual authenticator、SYNTHETIC credential） | ✅ 3 次獨立執行皆通過 | S1 spike `verify-product.mjs`（`run-1..3.json`，私人紀錄）；每次含 A（clipboard 拒絕 → prompt）、B（clipboard）、C（畸形 CODE 拒絕）、D（非 Coinbase origin 拒絕） |
| 真實點擊的 user activation | ⏳ | `Page.navigate("javascript:…")` 只是代替；需使用者本人 |
| 真實 OS Passkey | ⏳ | 需使用者本人；AI 不使用真實 Passkey |

## Consequences

- 書籤程式一改就換 sha256 與版本號；頁面（`src/ui/BookmarkletSigner.tsx`）顯示目前的 sha256 供使用者核對。頁面**不會**偵測使用者手上的舊書籤：舊版仍照樣產生 assertion，正確與否由我們頁面的 WebAuthn 驗證決定。
- 剪貼簿內容是 assertion：不是 secret，但依 INV-004 不寫入 log、URL 或 storage；它和其他路徑一樣，貼進同一個 assertion 欄位驗證。
