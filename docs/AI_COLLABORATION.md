# Working with AI

[繁體中文摘要](#繁體中文摘要)

**An AI assistant may read a redacted report, explain it and suggest a next step. Only you sign, and only you send.** You do not need any AI to recover your wallet.

## Using an AI assistant during a recovery

1. In the tool, open **AI report** and press **Copy report**. Read it before sharing: it contains the chain, short wallet and recipient forms (`0xA1b2…9F3c`), which steps are done, and the last error code.
2. Paste it into the assistant of your choice and ask what to do next.
3. Do what it suggests **in the tool's own interface**, checking each screen yourself.

| An assistant may | An assistant must never |
|------------------|-------------------------|
| Explain a status, an error code or a preview field | Ask for a seed phrase, private key, keystore, password, 1Password link or passkey data |
| Point out a mismatch and suggest previewing again | Give you code to paste into any website's console, or a bookmarklet of its own |
| Tell you which button to press and what you should see | Sign, send, or ask you to approve something you do not understand |

The report is built from an allowlist of fields. It never contains passkey assertions, signatures, a signed UserOperation, a full RPC URL or any gas-wallet secret. If an assistant (or a person) asks for any of those, stop: that is how scams work.

A useful way to read an assistant's answer is as a proposal you can check:

```
Proposal:  one sentence
Why:       which report field it is based on
You do:    which button or setting in the tool
You check: what you should see before pressing it
```

## How this project was built with AI

This repository was developed with AI coding assistants (Claude Code and Codex) under the [sd0x-harness](https://github.com/sd0xdev/sd0x-harness) workflow, directed and reviewed by the maintainer:

- Every code change went through an independent AI review and a local gate (typecheck, unit tests, build) before it was accepted; security-relevant changes were reviewed at the strictest tier.
- AI assistants worked only with synthetic data: synthetic passkeys, Anvil dev keys and a fake 1Password CLI. They had no access to real keys, keystores, passkeys or a private RPC, and never signed or sent a transaction.
- Every mainnet transaction in the project's history was signed and sent by a human.
- Hand-verified items that automation cannot cover (a real OS passkey prompt, a real browser wallet, VoiceOver, real audio) are tracked as manual checks, not counted as passing.

Contributors may use AI tools too; see [CONTRIBUTING.md](../CONTRIBUTING.md). You are responsible for what you submit: read it, run the tests, and never give an assistant real secrets.

## 繁體中文摘要

**AI 助手可以讀遮罩過的報告、解釋、建議下一步；只有你能簽署、只有你能送出。** 救援不需要任何 AI。

- 使用方式：在工具中開啟 **AI 報告** → **複製報告**，先自己看過內容再貼給 AI 助手；照建議操作時，一律在工具自己的介面上逐畫面核對。
- AI 永遠不該要你的助記詞、私鑰、keystore、密碼、1Password 連結或 Passkey 資料，也不該給你要貼到任何網站 Console 的程式或它自己的 bookmarklet。有人這樣要求，就停止：這正是詐騙的手法。
- 報告以欄位 allowlist 產生，永遠不含 Passkey assertion、簽章、已簽 UserOperation、完整 RPC URL 或 gas 錢包的秘密。
- 本 repo 由維護者主導，以 Claude Code 與 Codex 在 sd0x-harness 工作流程下開發：每個程式變更都經過獨立 AI review 與本機 gate；AI 只接觸 synthetic 資料，從未接觸真實金鑰、keystore、Passkey 或私人 RPC，也從未簽署或送出交易。專案歷史上的每一筆 mainnet 交易都由真人簽署送出。自動化無法涵蓋的項目（真實 OS Passkey、真實瀏覽器錢包、VoiceOver、真實音訊）列為人工檢查，不算作通過。
