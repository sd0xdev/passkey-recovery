# Feasibility Study: 不用 DevTools Console 的 Passkey 簽署

> **Doc class**: Lifecycle — Phase 0 feasibility。研究日期 2026-10-31，全部為公開來源唯讀讀取；沒有執行任何 WebAuthn ceremony、沒有安裝 extension、沒有使用真實 Passkey。
> **決策紀錄**：[adr-001-no-console-signing.md](./adr-001-no-console-signing.md)

## 1. 問題

Coinbase Smart Wallet 的 passkey owner 註冊在 RP ID `keys.coinbase.com`。救援要的是一個 WebAuthn assertion，它的 `challenge` 必須等於**我們自己預先建好**的 raw `userOpHash`（Plasma 9745、EntryPoint v0.6）。現行工具用的方法是：使用者在 `https://keys.coinbase.com/connect` 打開 DevTools Console，貼上一段短 helper，由它呼叫 `navigator.credentials.get`。這條路可行（本 case 完成兩筆），但對大眾發佈來說有三個問題：

1. 「打開 Console 貼程式碼」正是 self-XSS 詐騙的標準話術。教使用者這樣做，等於訓練他們在詐騙裡也照做。
2. 一般使用者不熟悉 DevTools，容易貼錯，也容易被替換成惡意版本。
3. 行動裝置沒有 Console。

## 2. 證據等級

| 標記 | 意義 |
|------|------|
| **Verified** | 已從原始來源讀到原文，或已實際觀測（附來源與日期） |
| **Inferred** | 由 verified 事實推論，沒有來源直接寫明 |
| **Unverified** | 沒有來源，或需要實機 spike 才能知道 |

## 3. 必須先成立的事實

| # | 事實 | 等級 | 來源 |
|---|------|------|------|
| F1 | RP ID 必須是呼叫者 origin effective domain 的 registrable domain suffix（或相等）；`http://localhost` 是合法 origin，但 RP ID 只能是 `localhost` | Verified | W3C WebAuthn Level 3，W3C Recommendation 2026-08-25，§4 "RP ID" |
| F2 | 因此本機工具（`127.0.0.1`／`localhost`）**不能**直接以 `keys.coinbase.com` 為 RP 呼叫 `navigator.credentials.get` | Inferred（由 F1 直接推得） | 同上 |
| F3 | Related Origins 需要 RP 在 `https://<rpId>/.well-known/webauthn` 以 `application/json` 列出 origins；只有 RP 網域擁有者能開啟 | Verified | WebAuthn L3 §5.11、§5.11.1 |
| F4 | `keys.coinbase.com/.well-known/webauthn` 回 200、`text/plain`、內容 `{"origins": ["https://tba-web-dev.cbhq.net"]}` | Verified（2026-10-31 兩次獨立讀取） | 實際 HTTP 回應 |
| F5 | `validateUserOp` 對 **raw** `userOpHash` 驗簽，WebAuthn challenge = `abi.encode(hash)` | Verified | coinbase/smart-wallet tag `v1.1.0`，`src/CoinbaseSmartWallet.sol` L191、L342 |
| F6 | ERC-1271 `isValidSignature` 驗的是 `replaySafeHash(hash)`（EIP-712 `CoinbaseSmartWalletMessage(bytes32 hash)`，domain 含 chainId 與 wallet 地址） | Verified | 同 tag，`src/ERC1271.sol` L23、L70 |
| F7 | 所以任何經 ERC-1271 流程（`personal_sign`、`eth_signTypedData_v4`）取得的簽章，challenge 不是 raw userOpHash，**不能**當 UserOp signature | Inferred（由 F5、F6 推得；popup 是否另加 EIP-191 包裝 Unverified，但不影響結論） | — |
| F8 | `REPLAYABLE_NONCE_KEY = 8453` 的跨鏈 hash 只允許 owner 管理與 `upgradeToAndCall`，不能用來轉帳 | Verified | `CoinbaseSmartWallet.sol` L51、L281 |
| F9 | EIP-5792 `wallet_sendCalls` 的 calls 只有 `{to, data, value}`；dapp 無法指定 nonce／gas／userOpHash | Verified | EIP-5792（Final） |
| F10 | `@base-org/account` 2.6.0 的 popup 方法清單沒有「簽 caller 提供的 raw hash」的方法；`wallet_prepareCalls` 的 UserOp 由後端建立，只用於 sub-account | Verified（client 原始碼） | base/account-sdk `packages/account-sdk/src/sign/base-account/Signer.ts` |
| F11 | popup 支援哪些 chain 由 popup 回應決定；9745 是否被接受未知 | Verified（機制）／Unverified（結果） | 同上 |
| F12 | Chrome `chrome.scripting.executeScript` 需 `scripting` 權限＋host permission 或 `activeTab`；`world: "MAIN"` 與頁面 JS 共用環境 | Verified | developer.chrome.com scripting API |
| F13 | `activeTab` 只在使用者手勢（action click、context menu、commands 快捷鍵、omnibox）後暫時授權當前 tab 的 main-frame origin，跨 origin 導覽即撤銷 | Verified | developer.chrome.com activeTab |
| F14 | 由 extension 注入 MAIN world 的 `navigator.credentials.get` 以 `https://keys.coinbase.com` 為 origin、且 extension 點擊算作頁面的 transient user activation | **Unverified** | 沒有來源；需要 spike |

## 4. 候選路徑

| # | 路徑 | 結論 | 等級 | 主要理由 |
|---|------|------|------|----------|
| P1 | 本機 UI 直接呼叫 `navigator.credentials.get({rpId: "keys.coinbase.com"})` | ❌ 不可行 | Inferred（F1–F2） | RP ID 規則 |
| P2 | Related Origins（把我們的 origin 加進 `.well-known/webauthn`） | ❌ 不可行 | Verified（F3–F4） | 只有 Coinbase 能改；現況不含我們 |
| P3 | 在我們的頁面 iframe 嵌入 keys.coinbase.com | ❌ 實務不可行 | Inferred | iframe 內仍是 Coinbase 的程式，我們無法讓它簽我們的 hash；framing 政策 Unverified |
| P4 | Coinbase SDK（`@base-org/account`）`personal_sign`／`eth_signTypedData_v4` | ❌ 不可行 | Inferred（F7） | 簽章 domain 不同（replaySafeHash ≠ userOpHash） |
| P5 | SDK `wallet_sendCalls`／`eth_sendTransaction` 在 9745 | ⚠️ 需 spike（S3），預期 no-go | Unverified（F11） | 即使接受 9745，也是 Coinbase 建 UserOp、自選 bundler；無法綁定我們的 exact nonce／fees，且違反「本機 exact signed simulation 後才送出」 |
| P6 | SDK `wallet_sign`（popup 自定型別） | ⚠️ 需 spike（S4） | Unverified | 參數與 popup 行為不開源 |
| P7 | SDK 登入成功（`wallet_connect`／`eth_requestAccounts`） | ❌ 不算數 | Verified（F10） | 只證明 session，不等於能簽 raw UserOp |
| P8 | **Bookmarklet**（使用者在 keys.coinbase.com 點書籤列上的 `javascript:` 書籤） | ⚠️ 需 spike（S1） | Unverified | 不需 Console；仍是在 Coinbase 頁面執行使用者提供的程式（self-XSS 同類風險），CSP 是否阻擋、是否算 user activation 都未知 |
| P9 | **MV3 browser extension**（`activeTab`＋`scripting`，只在使用者點擊後注入 keys.coinbase.com） | ⚠️ 需 spike（S2） | Unverified（F14） | 可做 exact origin／top-frame／path 檢查與配對，但要處理供應鏈、權限、行動裝置限制 |
| P10 | Console helper（現行方式） | ✅ 可行（本 case 實證） | Verified（兩筆主網交易） | 只能當「進階手動流程」，附 self-XSS 警告 |
| P11 | 一次性加入新的 owner（例如本工具自有 RP 的新 passkey 或使用者 EOA），之後原生簽署 | ⚠️ 產品決策 | Inferred | 加 owner 本身仍要一次 keys.coinbase.com 簽署；永久改變錢包的權限結構，風險高，不適合預設 |

## 5. Extension（P9）必須滿足的條件（設計約束，非已驗證）

| 面向 | 要求 |
|------|------|
| 觸發 | 只在使用者點擊 extension action 後執行；沒有 content script 常駐、沒有 `<all_urls>` |
| 權限 | `activeTab`＋`scripting`，不要求 `host_permissions`、`tabs`、`storage`、`cookies`、`webRequest` |
| Origin 檢查 | 注入前在 extension 端確認 tab URL 的 origin 嚴格等於 `https://keys.coinbase.com`、path 在 allowlist、是 top frame（`frameId == 0`）；注入的函式內再檢查一次 `location.origin` 與 `window.top === window` |
| 敏感回傳 | assertion 只透過 `InjectionResult.result` 回到 extension，不寫入頁面 DOM、不 `postMessage` 到頁面、不用 clipboard |
| 配對 | 本機 UI 顯示一次性配對碼；extension 與本機 UI 以配對碼綁定，避免任意網頁或其他本機程式接收 assertion |
| Local bridge | 若用 native messaging 或 loopback，只接受已配對 extension ID，拒絕一般網頁 origin；沒有 bridge 時改為使用者手動貼上（以 short code 比對） |
| Replay | 每個 challenge 綁定一份 intent 與到期時間；同一 challenge 只接受一次；intent 改變即作廢 |
| 訊息來源 | 只接受 `chrome.runtime` 來源訊息並驗證 `sender.id`；不接受 `window.postMessage` |
| 更新供應鏈 | 預設以 unpacked、可重現建置、hash 公開的方式發佈；若上架商店，啟用 2FA、版本 hash 公告、權限變更需重新審視 |
| 行動裝置 | Chrome Android 與 iOS Safari 的 extension 支援 Unverified；行動版本先不承諾 |
| 禁止 | 不關閉 origin 檢查、不攔截或修改 Coinbase 的 WebAuthn 呼叫、不讀取其他網站、不匯出憑證 |

**MAIN world 的風險**（Inferred）：注入的函式與頁面共用 JS 環境，頁面自己的程式可以覆寫 `navigator.credentials`。對 keys.coinbase.com 這是同一個信任方（頁面本來就能用使用者的 Passkey），但 extension 不能宣稱「頁面無法看到 assertion」。

## 6. Spike 計畫（go／no-go）

每個 spike 在 synthetic 或測試帳號上做，不使用本 case 的 Passkey、不碰主網資產。

| ID | 問題 | 方法 | Go 條件 | No-go 條件 |
|----|------|------|---------|-----------|
| S1 | Bookmarklet 能否在 keys.coinbase.com 呼叫 `navigator.credentials.get` 並取得 challenge 正確的 assertion？ | 測試用 Passkey；Chrome／Safari／Firefox 各一次；以 dummy 32-byte challenge | 三個瀏覽器中至少 Chrome 成功；`clientDataJSON.origin == "https://keys.coinbase.com"`、challenge 相符；不需 Console | CSP 阻擋、NotAllowedError（無 user activation），或回傳無法安全帶回本機 |
| S2 | MV3 extension（activeTab＋scripting，MAIN world）是否同 S1 可行？ | unpacked extension；同 S1 驗證項目＋`frameId == 0` 檢查 | Chrome 成功且只需 `activeTab`、`scripting`；回傳路徑不經頁面 | 需要更廣權限，或 user activation 不成立 |
| S3 | SDK popup 是否接受 chain 9745？ | 測試帳號 `wallet_switchEthereumChain(0x2611)` | 只記錄結果；即使 go 也只作為「Coinbase 代建 UserOp」的參考，不取代本機 exact simulation | 被拒（預期） |
| S4 | `wallet_sign` 是否能簽 caller 提供的 raw 32-byte hash？ | 測試帳號、dummy hash；檢查回傳 assertion 的 challenge | challenge == raw hash 且無額外包裝 | 有包裝或不支援（預期） |

## 7. 結論（本階段）

在 spike 之前，**沒有任何已驗證的免 Console 路徑**。推薦順序：S2（extension）作為主要候選，S1（bookmarklet）作為輕量備案，P10（Console）保留為已驗證的進階手動流程；S3／S4 只為了正式關閉 SDK 路徑。決策見 ADR-001。

## 8. Sources（2026-10-31 讀取）

- https://www.w3.org/TR/webauthn-3/ （§4、§5.9–§5.11）
- https://keys.coinbase.com/.well-known/webauthn
- https://github.com/coinbase/smart-wallet/tree/v1.1.0/src （`CoinbaseSmartWallet.sol`、`ERC1271.sol`、`CoinbaseSmartWalletFactory.sol`）
- https://github.com/base/account-sdk （`packages/account-sdk/src/sign/base-account/Signer.ts`）
- https://eips.ethereum.org/EIPS/eip-5792
- https://developer.chrome.com/docs/extensions/reference/api/scripting
- https://developer.chrome.com/docs/extensions/develop/concepts/activeTab
- https://docs.cdp.coinbase.com/coinbase-wallet/overview
