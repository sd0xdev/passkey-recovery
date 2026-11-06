# ADR-003：以使用者自行啟動、明確配對的本機 runner 提供 hosted 網站的模擬與 native 簽署

> **Status**: Accepted（2026-11-01）。**Supersedes**: `hosted-local-architecture-addendum.md`「hosted 不需本機 Node／Anvil」一句（使用者 override，`current-product-scope.md`）。**Amends**: [INV-005](./intent-open-source-recovery.md)（2026-11-01 amendment）。規格：[`5-hosted-local-runner.md`](./5-hosted-local-runner.md)。
>
> **Amendment（2026-11-02，M5）**：npm 套件改名為 `passkey-recovery`（0.2.0，與 repo 同名），下載檔為 `passkey-recovery-<version>.tgz`，以 `npm exec --yes --package ./passkey-recovery-<version>.tgz -- passkey-recovery` 啟動；bin 名稱、`private: true`、綁定與配對決策不變。下方 Decision 1 保留決策當時的套件名。

## Context

- 模擬（部署與轉帳的 fork 執行）需要 Anvil；靜態網站自己跑不了。雲端模擬等於代管使用者的交易內容與 RPC，違反「不信任代管服務」的 North star。
- 使用者希望網站與本機是同一份 UI，且能使用 1Password 與 native File 作為 gas 錢包；這兩者都需要一個能呼叫 `op`、讀寫 OS app-data 的本機程序。
- 原 INV-005 禁止「任何網站都能呼叫、持有金鑰的 localhost 廣播 API」。

## Decision

1. **Runner**：單一 npm 套件 `coinbase-passkey-recovery`（bin `passkey-recovery`；目前 `private: true`、未上 registry，以 `npm exec --yes --package ./coinbase-passkey-recovery-<version>.tgz -- passkey-recovery`（下載的 tgz；尚未上 npm registry）或 source checkout 的 `npm run runner` 啟動），只綁 `127.0.0.1`；打包 keyless sidecar、sha256 釘選的 Anvil（lazy）、native signer child。runner 本身也提供同一份 UI（localhost fallback，免配對）。
2. **配對**：網站只能經 (a) 使用者自己啟動 runner、(b) 瀏覽器 Local Network Access 提示、(c) 輸入 runner 印出的一次性 `XXXX-XXXX` 代碼，三者都成立後取得綁 origin 的 session token。Origin 是 exact https allowlist（目前只能用 `--allow-origin` 指定；`OFFICIAL_ORIGINS` 空）。
3. **金鑰隔離**：金鑰只在 signer child；sidecar 與網站經 IPC 請它簽 sidecar 自己 issue 的 exact tx，簽完由 sidecar 驗證後轉送。網站永遠拿不到金鑰或密碼以外的 secret 回應（unlock 只回地址）。
4. **沒有雲端 fallback**：沒有配對的 runner 時，網站上需要 API 的步驟（診斷、模擬、送出）停用並說明原因，不改走任何遠端服務。

## Alternatives

| 方案 | 不採用原因 |
|------|-----------|
| 雲端模擬服務 | 代管交易內容與 RPC；需營運與付費；違反 North star |
| 網站內 WASM EVM | 無法重現 Plasma fork 狀態的完整語意；工作量大 |
| 只有本機、不做網站 | 使用者明確要求同一份 UI 可 hosted |
| 無代碼、只靠 origin allowlist | 惡意擴充或同 origin XSS 可直接使用；代碼讓「本人在場」成為必要條件 |

## Consequences

- 使用者需要 Node 24＋npm，以及一次 `npm exec`（發布到 registry 後才會是 `npx passkey-recovery`）；runner 的 help 與 UI 文案必須清楚說明在哪裡執行（NX-04）。
- 新增攻擊面：本機 HTTP API。以 Host（防 DNS rebinding）、Origin、代碼、token 期限、body 上限與 redaction 控制（HOST-05）。
- Extension bridge 目前只認 4173；runner 與網站上用 bookmarklet（[ADR-004](./adr-004-bookmarklet.md)）或 DevTools helper。
