# Checklist：M2 真實 OS passkey 手動驗證（PM／使用者執行）

> **Doc class**: Ancillary checklist。自動化只覆蓋 virtual official-origin 與 mock 層（`requests/2026-10-31-m2-spike-results.md`（私人紀錄，不公開） §1）；本清單補上**真實手勢＋真實 passkey** 層。AI 不執行本清單。
> **只做 proof 簽署，不轉帳**：proof 的 challenge 是一段明文聲明的 SHA-256，不是 `userOpHash`，簽出的東西不能移動資產。不需要也不得執行 `npm run signer -- deploy|withdraw`。

## 前置

- [ ] 使用**另建的** Chrome profile（`chrome://settings/manageProfile` → 新增），不要用日常 profile
- [ ] `npm run build && npm start`；畫面在 `http://127.0.0.1:4173`
- [ ] `chrome://extensions` → 開發人員模式 → 「載入未封裝項目」選 repo 的 `extension/`；確認 ID 是 `imkijjdbgdekpebmpdjpgngpdambepok`，權限只列「讀取及變更你按下時所在網站的資料」類（activeTab）
- [ ] 把 extension 釘選到工具列

## M-1 Extension bridge（真實點擊＋真實 passkey）

| 步驟 | 預期畫面 | 記錄 |
|------|----------|------|
| 1. UI「控制權證明（非交易）」區塊按「產生新的 challenge」，再按「傳給擴充功能」 | 顯示 `XXXX-XXXX` 配對碼，按鈕變成「等待 keys.coinbase.com…」 | 配對碼 |
| 2. 新分頁**自己輸入** `https://keys.coinbase.com/connect`（不必登入） | Coinbase 頁面 | — |
| 3. 按工具列的 Passkey Recovery 按鈕 | 頁面跳出確認框，內含**同一個**配對碼 | 兩邊是否一致 |
| 4. 按「確定」 | 系統 passkey 對話框（Touch ID／iCloud Keychain／security key），RP 顯示 keys.coinbase.com | 對話框類型 |
| 5. 完成驗證 | 回到 UI：「已收到 assertion，已放入下方欄位」；按「驗證」，結果各項 ok（你的 passkey 是 owner[0] 時應為 match） | 截圖**只裁切「結果」區塊**（不可含 assertion 輸入欄，該欄是完整 assertion 原文） |

對照組（每項各做一次）：
- [ ] 步驟 3 改在其他網站按按鈕 → 不跳確認框，UI 仍等待
- [ ] 步驟 4 按「取消」→ UI 顯示 cancelled
- [ ] 未按「傳給擴充功能」直接在 keys 頁按按鈕 → 不跳確認框
（「其他 origin 拿不到 `chrome.runtime`」已由自動化在 127.0.0.1:4179 驗證，不必手動做。）

## M-2 Bookmarklet（S1 備案；只為記錄，不必做）

只在 PM 要求時做：記錄真實書籤列點擊後 `navigator.userActivation.isActive` 與剪貼簿寫入是否成功。

## 回報

把各步驟「記錄」欄與裁切後的截圖交給 PM；送出前確認畫面中沒有 assertion 欄位、challenge、配對碼以外的長字串。完成後關閉 UI 分頁，讓 assertion 離開記憶體。**不要**貼上 assertion 原文、簽章、私鑰或完整地址。
