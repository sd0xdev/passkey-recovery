# Runbook — AI 協作 protocol（草案）

> **Doc class**: Ancillary — runbook（current authority，草案；尚無實作）。
> 適用對象：(1) 使用 Recovery UI 的人，想請 AI 助手解讀狀態；(2) 開發者以 Claude Code／Codex 開發本專案。
> 上游：[2-tech-spec.md](./2-tech-spec.md) · [3-architecture.md](./3-architecture.md) §2

## 1. 一句話

**AI 可以讀 redacted 狀態、解釋、提出下一步；只有人能簽署、只有人能送出。** 使用者不需要 Claude、Codex 或 sd0x-harness 就能完成救援；AI 是選配。

## 2. 四個邊界

| 邊界 | AI 可以 | AI 不可以 |
|------|---------|-----------|
| Read | 讀使用者貼上的 redacted status report；讀開源 repo 與文件 | 讀 raw assertion、signed UserOp、私鑰、密碼、seed、RPC secret、keystore、瀏覽器 profile |
| Preview | 解讀 preview 欄位、指出不一致、建議重新預覽 | 自己建立或修改 intent 送進 UI |
| Human signs | 說明簽署會綁定哪些欄位 | 觸發 Passkey、提供要在其他網站貼上的程式碼（Advanced 流程的程式只能由本機 UI 產生並顯示 hash） |
| Human sends | 說明送出後會發生什麼、如何追蹤 | 呼叫 EIP-1193、`eth_sendRawTransaction`、`eth_sendUserOperation`、任何廣播 |

預設模式是 **manual-assisted／local**：使用者自己複製 report 貼給 AI，AI 的回覆是給人看的文字。

## 3. 資料格式

### 3.1 Status report（UI → 人 → AI）

UI 的「Export report」產生，固定欄位、固定 redaction：

```json
{
  "schema": "cbpr.status/1",
  "app": { "version": "<semver>", "build": "<sha256 前 12>" },
  "chain": { "id": 9745, "name": "Plasma", "rpc": "public|custom", "capabilities": ["read","estimate","fork"] },
  "wallet": { "short": "0xA1b2…9F3c", "status": "counterfactual", "reasons": [] },
  "infra": { "entryPoint": "ok", "factory": "missing", "implementation": "missing" },
  "transfer": { "state": "previewed", "asset": "USDT0", "amount": "250.000000", "recipientShort": "0x5B7e…c8D2", "userOpNonce": 2 },
  "lastError": { "code": "nonce-changed", "at": "2026-10-31T11:00:00Z" }
}
```

**永遠不在 report 中**：assertion（authenticatorData、clientDataJSON、signature）、signed UserOp、任何簽章材料、完整 RPC URL、gas wallet 的任何秘密、完整餘額以外的個人資訊（餘額以使用者選擇是否附上）。Redactor 以 allowlist 實作（只輸出 schema 內欄位），不是 denylist。

### 3.2 Action proposal（AI → 人）

AI 的建議以人能逐項核對的形式回覆：

```
Proposal: <一句話>
Why: <依據 report 的哪個欄位>
You do: <在 UI 上按哪個按鈕／改哪個設定>
You check: <按之前要看到什麼>
Not doing: <AI 不會做的事，例如不會替你簽署>
```

AI 不得在 proposal 中要求使用者貼上任何秘密，也不得要求使用者到其他網站的 Console 貼程式。

## 4. MCP（未來，optional）

若提供 MCP server，只開放唯讀工具：

| Tool | 回傳 |
|------|------|
| `get_status` | 3.1 的 redacted report |
| `get_capabilities` | RPC probe 結果 |
| `explain_error` | 錯誤碼的說明與建議 |
| `propose_action` | 回一份 3.2 格式的 proposal，**只顯示在 UI 的「Suggestions」區**，需要人按按鈕才會執行 UI 自己的動作 |

MCP **沒有**任何可以 sign、send、修改 intent、設定 RPC 或讀 storage 的工具。MCP server 與 sidecar 分開執行，只讀 sidecar 的 `/api/report`。

## 5. Prompt injection 與誤導

- 鏈上資料（token 名稱、合約回傳字串）可能含有給 AI 的指令。Report 只帶結構化欄位與 allowlist 內的 token symbol，不帶任意字串。
- AI 的任何建議都要能從 report 欄位推導；不能推導的建議，使用者應忽略。
- 若 AI 要求秘密或要求繞過 UI 的確認，這本身就是警訊：停止並到 GitHub issue 回報（不附秘密）。

## 6. 開發流程中的 AI（維護者）

本專案以 [sd0x-harness](https://github.com/sd0xdev/sd0x-harness)（MIT）作為**開發工作流**：hook 提醒、獨立 review gate、precommit。它不是 runtime 依賴，打包後的 UI／sidecar 不含任何 harness 程式碼，使用者不需要安裝它。

開發時的硬規則（沿用本 repo 的 `.claude/` 規則與 `CLAUDE.md` Footguns）：

| 規則 | 內容 |
|------|------|
| 不碰秘密 | AI 不讀 RPC URL 檔、keystore、gas wallet、歷史 raw assertion |
| 不送交易 | AI 不執行 `npm run signer -- deploy|withdraw` 或任何主網廣播 |
| 測試資料 | 只用 synthetic testchain 與 hash-pinned 研究向量 |
| Review | 程式碼變更走獨立 review → precommit；文件走 doc review |
| Git | AI 不自行 commit／push；由維護者決定 |

## 7. 使用者檢查清單（貼給 AI 之前）

- [ ] 我貼的是 UI 的「Export report」，不是截圖裡的地址欄或 Console 輸出
- [ ] Report 裡沒有我的 seed、密碼、RPC URL
- [ ] 我知道 AI 只會給建議，簽署和送出要我自己在 UI 按
