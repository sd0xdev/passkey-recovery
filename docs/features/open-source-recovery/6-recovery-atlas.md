# Recovery Atlas：網站機制圖冊與本機完整預覽

> **Doc class**: Lifecycle appendix（current authority）。**狀態：已實作**（2026-11-02，含同日 PM 修訂 §10）。本文描述現況；§9 是第一輪的驗收與證據，§10 是 PM 修訂的設計決定與驗收。程式：`src/ui/site/atlas/`、`src/ui/site/Site.tsx`、`src/ui/api.ts` 的 `pageKind`、`server/runner/runner.ts`。
> 來源：使用者 2026-11-02 選擇「A：同一地址，錢包尚未就緒」＋「B：原創海圖圖冊」合成一套方向，以及同日的 runner 修訂要求（本機預覽直接可用、官網啟動指令確實可用、預覽統一 4171）。PM brief 與驗收紀錄在私人 run 目錄，不公開。
> 上層與相鄰：網站與路由現行規則 [`design-ui-ux-guidelines.md`](./design-ui-ux-guidelines.md) §13；runner 與配對 [`5-hosted-local-runner.md`](./5-hosted-local-runner.md)；官網原則與禁用宣稱 [`4-open-source-and-website.md`](./4-open-source-and-website.md) §5。

**Recovery Atlas** 只是內部代號；公開名稱仍是 **Passkey Recovery by sd0x**，頁面上不出現「Atlas」。這裡的 A／B 是使用者這次選的兩個方向，跟 guidelines §13.1 被淘汰的「B. Vault blueprint」無關。

## 1. 要讓訪客看懂的事

1. 在支援的情境裡，資產已經在某個 Plasma 地址上，但 smart wallet 可能還沒部署，或其他執行條件還沒滿足。
2. 工具先檢查相容性、控制權與執行條件；需要且相容時才協助部署，**之後**由本人另外授權每一筆轉帳。Passkey 只能在 keys.coinbase.com 使用，這個限制不會消失。
3. 開始前看得懂要準備什麼、每一步誰執行、金鑰在哪裡、有哪些限制。不保證找回所有資產。

「同一地址」只描述支援的 counterfactual wallet 在部署前後地址不變。檢查、部署、授權、轉帳是四件事；不把所有問題歸因於未部署，也不說「登入 Passkey 就一定轉得出來」。

**禁止**（在 [`4-open-source-and-website.md`](./4-open-source-and-website.md) §5.5「禁用的宣稱」之外再加）：無條件保證可轉出（含改版前的首頁標題「Your passkey can still move them」／「你的 Passkey 仍然轉得出來」）；假餘額、假成功、即時感的數字；「所有尚未就緒的錢包都能救」；說 Coinbase 持有使用者的 Passkey 私鑰，或保證 Passkey 只在單一裝置上。

## 2. 視覺系統

### 2.1 機制 → 圖面的對應

| 真實概念 | 圖面 | 要避免的誤解 |
|---|---|---|
| 同一個 wallet address | 固定的**測量基準點**（圓＋十字＋座標標籤「Same address on Plasma／同一個 Plasma 地址」），三個狀態裡座標都不動 | 資產被橋接、換地址、重建私鑰 |
| 資產在那裡 | 基準點上的貨物標記（三個小方塊），永遠不移動 | 圖上的數量是餘額 |
| 錢包尚未部署（支援情境之一） | 基準點上的**虛線結構輪廓**——海圖慣例「規劃中、未建成」；旁邊有文字 | 頁面壞掉；工具已判定每位訪客都未部署 |
| 檢查與相容性 | **套準記號**（印刷 registration marks）對齊結構，三條引線註記：「Owner: your passkey」「Supported wallet version」「A gas wallet you hold pays the network fee／由你持有的 gas 錢包付網路手續費」（只指網路手續費；簽章綁定的 wallet fee 另計，見 [`design-ui-ux-guidelines.md`](./design-ui-ux-guidelines.md) §3 Direction A 的 manifest 費用欄），旁標空心圈＝「要確認」 | 動畫代表真的在讀鏈或驗證本人；註記是通過 |
| 需要且相容時部署 | 同一座標上虛線變實線、填上淡 `chart` 斜線；貨物標記原地不動；註記「Deployed only if needed and compatible」 | 部署＝已提款、已證明所有權 |
| 本人授權轉帳 | **不在主圖上**。只在第三段的產品 Demo（真實 UI、synthetic 資料）出現目的地與方向 | 首頁動畫自動簽署、保證可提領 |
| 責任邊界 | 第四段的「轄區圖」（HTML 區塊＋CSS 框線，不是 SVG，文字可選取）：網站、你的電腦（runner 與 native signer 兩個獨立區塊）、keys.coinbase.com 與你的 Passkey 提供者、Plasma；只畫被允許的通道 | 所有秘密都在網站；工具不處理任何私鑰 |

每張機制圖都標「Illustrative example／機制示意」，圖例寫「部署只在需要且相容時」。示意資料與工具的真實狀態不共用任何可寫狀態；網站頁不 import 工具的 state、API 或 runner 模組。

### 2.2 Tokens（沿用 guidelines §5、§13.2，只列這次的新增或改變）

| 項目 | 規則 |
|---|---|
| 色 | `fog #EEF2F3` 頁面、`paper #FFFFFF` 圖板紙、`hull #1D2A35` 墨、`chart #3F5B73` 線與次要字、`sounding #C9D7DD` 等深線與斜線、`buoy #C8410F` 只用於主要 CTA 與圖上的「你在這裡」指標。`kelp`／`flare` 保留給工具的真實成功／錯誤，網站插圖不用 |
| 深色圖板 | 第四段轄區圖用 `hull` 底、`fog` 線（印刷「夜間版」）：全頁唯一一段深底，用來轉換節奏；不是每段換底色 |
| 字 | 只用已打包的 Atkinson Hyperlegible Next（400／700／800）與 Mono。**不新增字體**（字體增量 0 KiB）：識別度放在圖，不放在 display 字。圖上所有文字（座標標籤、chain id `9745`、版號 `v1.1`）都用 Next；Mono 仍只用於地址／hash／金額值（guidelines §11），圖冊不新增 Mono 用途 |
| 圖板框 | 圖冊的 neatline：細外框＋刻度（每 40 px 一格），四角套準記號；圖號用羅馬數字 I／II／III（三張圖板真的是順序） |
| 線 | 主線 1.5 px、結構 2 px、虛線 6／5、引線 1 px；曲率、線寬、註記字級三種構圖一致 |

**對生成式預設的自我檢查**：沒有暖米色＋terracotta（底是冷灰 fog）；深底只有一段且主色是 slate navy、不是近黑＋螢光；沒有相同圓角卡片＋灰陰影（圖板是紙＋刻度框，2 px radius）；沒有 ALL CAPS eyebrow 與「WORD — fragment」標籤；編號只用在三張有順序的圖板。

### 2.3 版面與雙語

| 視窗 | 首屏 |
|---|---|
| 1440×900 | 左 5 欄：標題、一句用途、主要 CTA、次要 CTA、一行範圍；右 7 欄：主圖（固定基準點在圖板視覺重心偏左上）。主 CTA 與範圍行在第一個 viewport 內、不等動畫 |
| 768 | 文字在上、主圖在下（橫向裁切） |
| 390×844 | Header 一列：品牌、「Menu」（`<button aria-expanded aria-controls="site-menu">` 開關導覽清單；Escape 與換頁時關閉）、語言、開啟工具——焦點順序與視覺順序相同；≤ 420 px 品牌可換行（最多約 9em 寬），360 px 英文時「開啟工具」會換到第二列但不溢出。接著標題、短副標、CTA，第一屏內可見。主圖是**另外畫的直向構圖**（基準點在上、結構與註記往下堆疊），不是桌面縮小 |

繁中：獨立的字級（hero 比英文小一級）、行高 1.75、行寬 ≤ 34 字；不硬塞 `<br>`，用 `text-wrap: balance`（標題）／`pretty`（內文）與 `word-break: keep-all` 避免單字懸空；390／768／1440、320 reflow 與 200% zoom 都有檢查；200% zoom 以 1440×900 的一半、720×450 CSS px 視窗當代理（e2e 量 `scrollWidth`、CTA、圖板控制）。說明文字都是可選取的 HTML，圖上的 SVG 文字只是標籤，每個標籤在 HTML 有對應敘述。

## 3. 首頁資訊架構

PM 修訂（§10.3）後的順序：先講機制，再問「適合你嗎」，再看產品，最後一次講清楚誰握有什麼。

| 段落 | 內容 | 構圖 |
|---|---|---|
| 1 首屏 | 標題 EN「Your address is there. Your wallet may not be ready.」／繁中「地址還在，錢包可能尚未就緒。」；副標說明 Plasma、支援的 Coinbase Smart Wallet v1.1（passkey）與「先確認是否適用」；主 CTA「Check your wallet／檢查錢包」→ `/recover`（點擊時不宣稱已檢查）；次 CTA「See how it works／看看運作方式」→ 第二段；範圍行「Needs the runner on your computer. Independent and not audited.」 | 主圖（§2.1 狀態 I）＋播放控制；基準點座標字加大、貨物用 `hull`、等深線淡一階，焦點在基準點 |
| 2 三個步驟（`#how-plates`） | 「The same address, in three steps／同一個地址，三個步驟」：I「Funds sit at your address」→ II「What has to be true」→ III「Deployed only when needed」 | 三張靜態圖板縮成約 96–112 px 的縮圖，各自在說明文字旁（主圖的圖例），不是三張大構圖；動畫關閉時完整成立 |
| 3 適合你嗎 | 適用／不適用兩欄（不變） | ✓／✕ ledger |
| 4 走進產品 | 「Check → Deploy if needed → Approve → Track」四張真實 UI 局部截圖，synthetic 資料，**一次一張**：四個具名按鈕（`aria-pressed`）＋上一個／下一個＋「第 n 個，共 4 個」；每張都標「Demo, synthetic data／示範（合成資料）」 | 一張紙，跟圖板同一套框線；沒看到的那幾張是 `hidden`，lazy 圖片不會先載入 |
| 5 誰握有什麼（只一次） | 轄區圖四區；「這個頁面」區寫明它不持有要救援錢包的私鑰、gas 私鑰只在你於頁面建立或開啟 keystore 時存在分頁記憶體；Passkey 區寫明由 Passkey 提供者保存、可能同步、只能為 keys.coinbase.com 簽章。「它們之間僅有的通道」收在 `<details>`；完整說明連到 how-it-works | 深色夜間版圖板（全頁唯一一段深底） |
| 6 狀態、FAQ、開始 | 狀態 ledger（新增「發布：尚未發布；請在你的資料夾建置」）、FAQ、再一次主 CTA | 回到 fog 底 |

截圖產生：`scripts/design/capture-demo.mjs` 以 e2e 的 synthetic testchain 與 synthetic wallet（`test/support/e2e-servers.ts`）跑真實 UI，裁成 WebP 放 `src/ui/site/assets/`；不含真人地址、1Password private link、配對碼或既有收據。

## 4. 原創資產清單

| 資產 | 形式 | 原稿 |
|---|---|---|
| 主圖 master（基準點、貨物、結構三狀態、套準記號、註記） | 手寫 SVG path，React 元件 `src/ui/site/atlas/` | 元件本身即原稿；作者 sd0x（本 repo，Apache-2.0） |
| 主圖直向版（手機） | 同一組 primitive、另一組座標 | 同上 |
| 三張圖板 | 同一 master 的三個狀態，靜態 | 同上 |
| 轄區圖 | HTML 區塊＋CSS（`Boundary.tsx`、`atlas.css`） | 同上 |
| 產品 Demo 截圖 ×4 | WebP，由腳本從真實 UI 產生 | 腳本＋synthetic fixture |

清單與授權寫進 `src/ui/site/atlas/ASSETS.md`。不使用第三方圖片、字體或案例素材；等深線由 `geometry.ts` 的 `ring()` 決定性產生（原本的 `chart.ts` 已併入）。能力只用文字標示，沒有另做圖示組。

## 5. 動效與互動

### 5.1 分鏡

先交付三張完整靜態畫面，動效只在其上加變化。首屏自動入場只有基準點描線 0.9 s；完整敘事由訪客按 Play 才播（約 10 s），不循環。

| 鏡頭 | 時間 | 變化 | 訪客應理解 | 靜態替代 |
|---|---:|---|---|---|
| S0 | 0–2 s | 基準點與貨物在；虛線結構可見 | 地址與資產，和已部署的合約不是同一件事 | 圖板 I |
| S1 | 2–5 s | 套準記號移入對齊，三條註記依序出現（空心圈） | 要確認相容性、控制權、手續費；不是自動通過 | 圖板 II |
| S2 | 5–8 s | 虛線轉實線、斜線填入；貨物不動 | 部署保持同一地址，還不是轉帳 | 圖板 III |
| S3 | 8–10 s | 圖板淡出半階，指向第三段的 Demo（「Approve each transfer yourself」） | 轉帳需要本人另外授權 | 第三段 Demo |

### 5.2 規則

| 項目 | 規則 |
|---|---|
| 控制 | 播放／暫停／重播三個有文字的 `<button>`，加三個圖號按鈕（`aria-pressed`）直接跳到 I／II／III；全鍵盤；目前圖板的說明是 HTML（`aria-live="polite"`，切換時更新一次） |
| 時間 | 圖板狀態轉換 500–600 ms；按鈕回饋 150 ms；不 scroll-jacking、不自訂游標、不每段 fade-up、不無限漂浮 |
| 實作 | CSS transition／WAAPI，只動 `opacity`、`transform`，結構描線用 `stroke-dashoffset`（小面積 SVG，量測後保留）；不加動畫函式庫；CSP 不變（不需要 `unsafe-inline`） |
| 停止 | 頁面隱藏（`visibilitychange`）、主圖離開視窗（IntersectionObserver）或換頁時暫停；回來不自動續播 |
| Reduced motion | `prefers-reduced-motion: reduce`：沒有入場描線；Play 變成逐張切換、無過渡；第二段三張靜態圖板照常顯示 |
| 音效 | 網站沒有音效；工具的音效規則不變（guidelines §12，預設關） |
| 預算 | 首頁新增 JS ≤ 30 KiB gzip（不含現有 React 與網站 chunk）；原創視覺（SVG＋WebP）≤ 200 KiB 壓縮傳輸；字體 0 KiB |

## 6. Runner 模式能力映射與本機完整預覽

### 6.1 Port

| Port | 角色 |
|---|---|
| **4171** | runner 預設 UI／API port，也是唯一給使用者的完整本機預覽：`http://127.0.0.1:4171/`、`/recover` |
| 4172 | runner 的 native signer（`--port`＋1），內部，不是頁面入口 |
| 4174–4180 | e2e 隔離測試服務（`playwright.config.mts`、`test/support/e2e-servers.ts`）：4177／4178 是 testchain 模式的 runner 與其 signer；4179 是 hosted build 走 **HTTPS**（每次執行用 `openssl` 產生的自簽憑證，結束即刪），4180 是同一份 hosted build 走 HTTP（驗證靜態預覽判斷）。跑完即清；不是預覽 |

`DEFAULT_PORT` 是 4171，配對面板的預設位址相同。`npm run preview` 是「build＋以 4171 啟動 runner」（完整本機預覽）；只服務靜態檔的 Vite preview 是 `preview:static`（4181），頁面標示「Static preview, no runner」。

### 6.2 頁面怎麼判斷自己在哪裡

依頁面實際擁有的能力與 protocol，不依 hostname（`src/ui/api.ts` 的 `pageKind(session, buildMode, origin)`：有 session meta → runner 頁；hosted build 且 `https:` → 官網；其他 → 靜態預覽）：

| 情境 | 判斷 | 工具顯示 | 下一步 |
|---|---|---|---|
| Runner 自己的頁面 | 有 `cbpr-session` meta | 已連接（「就是提供本頁的那一個（版本 v…），不需要配對」） | 直接用；重新整理仍連接（每次載入拿新 session） |
| Runner 頁面，但 runner 停了／重啟了 | `runnerLost()` = `offline`／`stale` | 「Runner stopped」／「Runner restarted」 | 重新啟動 runner／重新整理 |
| HTTPS 官網，未配對 | 無 meta、`https:` | 三步：下載、帶 `--allow-origin <本站>` 啟動、輸入配對碼 | 使用者明確操作；不掃描 localhost |
| HTTPS 官網，已配對 | 有配對 | 已連接（配對的 runner，版本 v…） | runner 版本 ≠ 頁面版本時顯示「版本不同」提醒；protocol 不同仍拒絕配對 |
| 本機 HTTP 靜態預覽（Vite／`wrangler dev`／http 上的 hosted build） | 無 meta、非 `https:` | 「Static preview without a runner. It cannot pair: the runner accepts https websites only.」 | 指向 `http://127.0.0.1:4171/recover`（完整本機預覽）。**不顯示** `--allow-origin http://…` 這種必然被拒的指令 |

`CBPR_TEST_ALLOW_LOOPBACK_ORIGIN` 只給測試；任何頁面、文件、README 都不教使用者設定它。

### 6.3 官網啟動指令（與 distribution 契約一致）

- 套件還沒發布到 npm registry，repository 與 GitHub Release 也都還沒公開。Download 頁（§10.5）先寫發布狀態「尚未發布」，主要路徑是在使用者已有的資料夾 `npm ci`、`npm run build`、`npm pack`；規劃中的 Release 網址只以文字列在「發布之後（規劃中）」，不是連結。
- 指令都在 tgz 所在的資料夾執行：`npm exec --yes --package ./passkey-recovery-<version>.tgz -- passkey-recovery`（預設 4171）；官網只在 `https:` 頁面顯示加上 `--allow-origin <本站 origin>` 的版本。
- `scripts/release/pack-smoke.mjs` 在乾淨暫存資料夾驗證：`--version`、`--help` 的 port、`/` 與 `/recover` 帶 session、帶 https `--allow-origin` 時以印出的配對碼（只在記憶體）配對成功、token 可用於 `/api/config`、沒 token 401、重用配對碼 410、非 allowlist origin 被拒、HTTP origin 被拒、port 被佔用時提示、Ctrl-C 後沒有殘留程序。
- `scripts/release/preview-smoke.mjs` 照使用者的方式跑 `npm run preview`（移除所有 `CBPR_*`）：4171／4172 被佔用就拒跑；記錄 4171 的 listener PID、served entry asset 與 sha256、API 版本；`/`、`/recover` 帶 session；Chromium 在 `/recover` 已連接、顯示本版版號，重新整理、上一頁、下一頁後仍連接；最後停掉 process group 並確認兩個 port 都關閉（`scripts/release/smoke-lib.mjs` 的 `stopAll`：每個等待都有上限，wrapper 先結束但子程序仍佔 port 時補 SIGKILL）。

## 7. PM 驗收補充（本輪一起修）

| # | 問題 | 修法 |
|---|---|---|
| 1 | 首頁標題無條件保證可轉出 | 改用 §3 的標題與副標；FAQ 與 status 不得再出現保證句 |
| 2 | 「你的 Passkey 留在 Coinbase」混淆私鑰保存與 RP | how-it-works 改為：Passkey 由你的 Passkey 提供者（裝置、iCloud 鑰匙圈、Google 密碼管理工具或密碼管理器等）保存，**可能同步到你的其他裝置**；它只能為 keys.coinbase.com 產生簽章，所以要在那個網站上核准。本工具、runner 與 sd0x 都拿不到 Passkey 私鑰；工具每一筆轉帳只收到一個簽章。依據：W3C WebAuthn Level 3 §4（credential 以 RP ID scoped；private key 綁定其 authenticator，可能被 backed up 到其他 authenticator）、passkeys.dev 術語（synced／device-bound passkey、passkey provider）。首頁轄區圖的 Passkey 區（`bound.keys.d`）同步 |
| 3 | `/recover` 沒連 runner、帳戶空白、Check 不能按時，第一步卻標「進行中」 | Check 的狀態字依實際條件：沒有 runner →「Needs the runner／需要 runner」；可以開始 →「Start here／從這裡開始」；讀取中 →「Reading the chain／讀取中」；完成 → 原本的「Done」。只有真的在讀時才叫進行中 |
| 4 | 手機 header 三列、首屏太長、缺少產品特定的主體 | §2.3 的一列 header＋直向主圖 |

## 8. 分階段落地順序（2026-11-02 全部完成）

| 階段 | 內容 | 結束條件 |
|---|---|---|
| P0 文件 | 本文件、guidelines §11／§13 的註記、5-hosted-local-runner 的 port 與能力映射、request ticket | `/codex-review-doc` 通過 |
| P1 原型 checkpoint | 桌面／手機首屏、三張圖板、轄區圖草稿、S0–S3 粗分鏡（私人 run 的 design 目錄），與改版前截圖對照 | 依 §9 ART-1～ART-3 自評 |
| P2 Runner 與文案 | §6、§7 的 1–3 | 單元＋e2e＋pack-smoke 乾淨資料夾實跑 |
| P3 視覺實作 | 主圖、三圖板、Demo、轄區圖、內頁沿用圖冊語彙、手機 header、動效 | 截圖／錄影新舊對照、a11y、效能量測 |
| P4 Gate 與交接 | test review → code review → precommit → doc sync → doc review；4171 以最後的 build 重啟 | 全部 gate 在最後一次編輯後通過 |

## 9. 驗收（2026-11-02）

證據等級：**自動**＝在 repo 內可重跑的測試；**實跑**＝在本機實際執行的腳本報告（存私人 run 目錄，不進 repo）；**檢視**＝截圖／錄影的人工比對。

| ID | 結果 | 狀態 | 證據 |
|---|---|---|---|
| ART-1 | 三個示意狀態裡基準點座標不動；部署與轉帳分在不同構圖 | ✅ | 自動：`test/e2e/atlas.spec.ts`（主圖四個 shot（shot 3 以 reduced motion 的 Play 進入）的基準點位置（bounding box）相同；三張靜態圖板的基準點 `cx`／`cy` 與貨物座標相同；轉帳只在 Demo 段） |
| ART-2 | 主圖、三圖板、轄區圖三種構圖共用線寬／虛線／註記規則 | ✅ | `src/ui/site/atlas/atlas.css` 的共用 class、`ASSETS.md`；自動：`atlas.spec.ts` 轄區圖 EN／繁中（四個區域依序、runner 與 native signer 兩區塊在「你的電腦」內、四條通道、keys.coinbase.com）；檢視：1440／390 EN／繁中截圖 |
| ART-3 | 首屏看得出用途、Plasma 範圍、主要動作 | ✅ | 自動：`atlas.spec.ts`（390、768、1440 EN／繁中首屏內的標題、範圍行、CTA；手機 header 一列；720×450 reflow 代理 200% zoom）、`test/e2e/site.spec.ts`（320 reflow）；檢視：截圖 |
| ART-4 | 圖冊到產品畫面有連續性，Demo 與真實狀態分開 | ✅ | 自動：`atlas.spec.ts`（四張 Demo 載入且各有「示範（合成資料）」標記）、`test/unit/ui/atlas-assets.test.ts`（出貨檔與 `ASSETS.md` 的 SHA-256 一致）；實跑：`scripts/design/capture-demo.mjs` 從 synthetic testchain 重新擷取，每張從該步驟標題起取景、標題與畫面主體都在框內，四張都通過 1280×736 PNG 檢查；檢視：四張都看過 |
| ART-5 | 內頁沿用圖冊語彙，長文易讀；工具操作優先 | ✅ | 檢視：how-it-works、security、download、guide、recover 的 EN／繁中截圖；自動：`site.spec.ts` axe |
| MOT-1 | 動效說明狀態變化；不擋 CTA／捲動／鍵盤；可暫停、重播 | ✅ | 自動：`atlas.spec.ts`（鍵盤操作 Play／Pause／Replay 與 I／II／III、播放中 CTA 可用、離開首頁即停止） |
| MOT-2 | reduced motion 靜態完整、網站無音效、背景分頁暫停 | ✅ | 自動：`atlas.spec.ts`（`reducedMotion: 'reduce'` 無入場、圖板與控制鈕都無 transition、逐張切換；`visibilitychange` 暫停且不自動續播） |
| RUN-1 | 4171 的 `/`、`/recover` 直接連接、重新整理仍連接、上一頁／下一頁正常 | ✅ | 自動：`test/e2e/runner-preview.spec.ts`；實跑：`scripts/release/preview-smoke.mjs` 18／18（listener PID、entry asset sha256、API 版本、`preview:static` 4181 無 runner，結束後 port 全關） |
| RUN-2 | 官網指令以打包產物在乾淨資料夾實跑；未授權 origin 與 HTTP origin 被拒 | ✅ | 實跑：`scripts/release/pack-smoke.mjs` 6／6（含以印出的配對碼配對、401、410） |
| RUN-3 | 頁面區分 runner 頁、靜態預覽、已配對、版本不同、離線 | ✅ | 自動：`test/unit/ui/api-runner.test.ts`（`pageKind` 含 https／http origin）、`runner-preview.spec.ts`（HTTPS 官網 4179 與 HTTP 4180） |
| COPY-1 | §7 的 1–3 修正，EN／繁中一致 | ✅ | 自動：`test/unit/ui/site-copy.test.ts`、`test/unit/ui/stepWords.test.ts`、e2e |
| PERF-1 | 新增 JS／資產在 §5.2 預算內；首頁不載入工具 chunk | ✅ | 實跑：`scripts/design/budget-home.mjs`（JS +6 362 B gzip（含內嵌在 JS 的圖板 SVG）、視覺 84 904 B（四張 Demo WebP）、字體無新增；判斷邏輯由 `test/unit/release/budget-lib.test.ts` 自動測）；自動：`site.spec.ts` lazy chunk；lab（本機 loopback、Chromium、未節流）3 次中位數（4171 runner 頁）：1440 LCP 108 ms／CLS 0.0008，390 LCP 88 ms／CLS 0.0093；播放期間無 > 50 ms long task（1440 第一次冷載入時載入階段有 1 個，其餘 5 次載入為 0） |
| DOC-1 | 規劃／實作狀態正確；雙語無保證找回或未證明的安全宣稱 | ✅ | 最後一次 `/codex-review-doc` |

不量化理解率或轉換率（沒有真人研究資料）；不宣稱 Awwwards 水準；INP 需要 field 資料，本輪只報具體互動 trace。

## 10. PM 修訂（2026-11-02 第二輪）

PM 驗收第一輪後的五項修訂（要求與範圍見 [`requests/2026-11-02-pm-revision.md`](./requests/2026-11-02-pm-revision.md)）。方向不變；這一節記錄每項的設計決定。

### 10.1 PM-01 誠實的狀態字

原則：**目前步驟只有在請求真的進行時才顯示忙碌**；沒有請求時是「待你操作」。不做假的時間或進度動畫。

| 位置 | 狀態 → 文字（EN／繁中） | 依據 |
|---|---|---|
| Gas「既有 gas 錢包」的階段（`src/ui/gas/stages.ts` 的 `stageState`） | `input` your turn — fill in below／待你操作，請在下方填寫；`working` working／處理中；`waiting` waiting for your approval in the 1Password app／等待你在 1Password app 核准；`failed` 原因寫在下方；前後階段 `done`／`next` | `waiting`＝讀 item 或開 keystore 的請求正在等 1Password；`working`＝其他 signer 請求（例如找 manifest keystore）；只有 `working`／`waiting` 有呼吸動畫，且 reduced motion 時靜止 |
| Deploy 步驟標頭（`src/ui/stepWords.ts` 的 `deployWord`） | 等待 gas 付款方（錢包正在等你核准）→ 等待區塊確認（已送出、尚未最終）→ 需要注意（拒絕、改變、失敗、未知或最終結果不對）→ 規劃中 → 待你操作（gas 已選）／先選 gas 付款方 | 依實際的送出狀態，不依計時 |
| Move／Track 步驟標頭 | Move 進行中是「Continue the transfer／繼續轉帳」；Track 是「Following the chain／追蹤鏈上狀態」（它真的在輪詢） | — |

### 10.2 PM-02 390 px 的 gas sheet

| 決定 | 細節 |
|---|---|
| 選了就捲到表單 | 窄 sheet（< 900 px）選定方式後，表單捲進視窗（reduced motion 時不平滑）；390×844 實測：表單標題約在 y 101–108、下一個欄位在 viewport 內 |
| 回到選擇 | 表單標題列有「Change how gas is paid／改用其他付款方式」：聚焦已選的 radio，方向鍵即可換；寬版（兩欄都在畫面）不顯示 |
| 收合 | 方式說明改成 `<details>`「How this way works／這個方式如何運作」，窄版預設收合、寬版預設展開；窄版把可用方式的說明行收起（不可用的方式仍顯示原因），keystore 來源選擇用精簡列 |
| 不變 | 五種方式、完整 gas 付款地址確認、兩種 keystore 來源、鍵盤與 axe、320 reflow |

### 10.3 PM-03 首頁節奏

順序與每段內容見 §3。決定：

- **三張圖板留下、縮小**：reduced motion 時它們是完整的敘事，所以不刪；但作為主圖的圖例呈現，不再是三張與主圖同尺寸的構圖。e2e 仍檢查三張的基準點與貨物座標一致。
- **Demo 一次一張**：四張同時攤開會把首頁拉長且重複，逐張切換讓「示範」的身分清楚；每張保留標記。
- **缺少建立資料是下一步，不是拒絕**：`server/diagnose.ts` 的 `needsEvidence`（唯一的阻擋原因是缺建立證據）時，Check 顯示「還需要一項資料：這個錢包的建立資料」與「補上建立資料」（打開證據欄並聚焦），不顯示紅色「目前無法協助」標頭；建立資料錯誤時仍照常顯示阻擋原因。Demo 的 Check 截圖重拍。
- **邊界只講一次**：刪掉與轄區圖重複的 holders 清單，把其中「這個頁面」的 gas 私鑰說明與 Passkey 的保存方式併進轄區圖的區塊；通道細節收進展開；完整說明在 how-it-works。
- **內頁連續性**：內頁標題下方加一條和圖板外框同樣刻度的 neatline（CSS），工具頁不加。

### 10.4 PM-04 模式一致

`pageKind()`（§6.2）也決定網站內頁怎麼說：

| pageKind | how-it-works／guide／download 的模式說明（`ModeNote`） | gas「需要 runner」提示 |
|---|---|---|
| `runner` | 這個頁面由你的 runner 提供：直接用，不需要配對 | runner 的 native signer 已關閉 |
| `website`（https） | 以本站確切 origin 啟動 runner（顯示帶 `--allow-origin <origin>` 的指令），再按「連接 runner」輸入網址與配對碼；或直接開 runner 印出的網址 | 需要為本站啟動並連接的 runner |
| `static-preview`（http） | `<origin>` 是沒有 runner 的靜態預覽，無法配對；改開 runner 印出的網址（顯示不帶 origin 的指令） | 需要 runner 自己的頁面；這個預覽沒有 runner |

Download 的 `--allow-origin` 指令也只在 `website` 出現。

### 10.5 PM-05 發布狀態與 Download

| 區塊 | 內容 |
|---|---|
| 發布狀態 | 版本、檔名、「尚未發布。repository 與 GitHub Release 都還沒有公開。」 |
| 在你的資料夾建置並執行（`#dl-local`） | 模式說明；Node／npm 版本；`npm ci`、`npm run build`、`npm pack`；記下 tgz 的 SHA-256；`npm exec --yes --package ./<tgz> -- passkey-recovery`；https 網站另列帶 `--allow-origin` 的指令；開啟印出的網址 |
| 發布之後（規劃中） | 規劃的 Release 網址以文字列出，不是連結 |
| 重建合約、授權 | 不變；LICENSE 與 THIRD_PARTY_NOTICES.md 寫「在原始碼資料夾」 |

其他入口一起改：footer「Source code」連到 `/download#dl-local`；Security 的 SECURITY.md、how-it-works 的 notices、工具說明的 runbook 都改成「原始碼資料夾裡的檔案」，不連到尚未公開的 repo。作者與 sd0x-harness 的 GitHub 連結不變（它們是公開的）。

### 10.7 PM 追加：轉帳之後（PM-06～PM-09）

同一輪 PM 追加的四項，來自真人操作時看到的問題（要求見 [`requests/2026-11-02-pm-revision.md`](./requests/2026-11-02-pm-revision.md) §1）。狀態：**已實作**（2026-11-02，測試見 §10.6）；純判斷在 `src/ui/balanceRead.ts`、`src/ui/stepWords.ts`，畫面在 `Tool.tsx`／`MoveStep.tsx`／`TrackStep.tsx`，複製狀態是 `ux.tsx` 的 `useCopy`。不代表 PM 驗收。

**PM-06 餘額刷新**。Move 的可用餘額取自 Check 的 diagnosis；轉帳成功後與新轉帳開始時都要重新讀，且舊的讀數不能當成目前餘額。

| 狀態（`balance`） | 何時 | Move 顯示 | 可以 Review 嗎 |
|---|---|---|---|
| `fresh` | Check 的結果，或重新讀取成功 | 餘額與讀取的區塊 | 可以（金額不超過餘額） |
| `reading` | 這個錢包的一筆轉帳在鏈上有結果（成功、內部呼叫失敗或外層 revert；UserOp 的 nonce 是否已用掉由追蹤結果判斷，餘額與 nonce 都重新確認），或按了「再來一筆」／「清除重來」／「重新讀取餘額」 | 「正在重新讀取餘額」與上一次的區塊 | 不行 |
| `failed` | 重新讀取失敗（runner 離線、RPC 錯誤） | 原因、「重新讀取餘額」按鈕，舊數字標成「區塊 N 的讀數，早於你上一筆轉帳」 | 不行 |

規則：只有最新一次讀取、同一個 RPC epoch、同一個 runner 連線、同一個錢包的答案會套用；舊答案丟掉。runner 沒有回應時按「重新讀取餘額」立即顯示失敗與原因，舊讀數不再算新鮮（2026-11-03 補修：原本無聲略過）。刷新只讀狀態（`/api/diagnose`，已部署的錢包只讀快照，不建 fork），不送出、不簽署、不解鎖、不碰收據與追蹤紀錄；輸入的金額與收款地址保留。金額超過新鮮餘額時，Review 不可按並說明原因。

**PM-07 再來一筆／清除重來**。按鈕依「這一筆」的結果決定：

| 這一筆的狀態 | 按鈕 | 清掉什麼 | 不會發生什麼 |
|---|---|---|---|
| 鏈上確認成功（`confirmed`／`final`，內部呼叫成功） | 「再來一筆」 | 本頁的表單、plan、簽章欄；重新讀取餘額 | — |
| 草稿、預覽、過期、模擬失敗 | 「清除重來」 | 同上，並請 runner 捨棄這個未送出的 plan | — |
| 已簽、尚未送出 | 「清除重來」，旁邊說明：這個頁面捨棄它、不會送出；簽章不會在鏈上撤銷，在它使用的錢包 nonce 被其他交易用掉之前，任何同時持有它與這筆轉帳的人仍可送出（10 分鐘檢查時間只限制頁面，不限制簽章） | 同上 | 不宣稱「已撤銷」 |
| 送出中、結果未知、內部呼叫失敗或 revert | 「清除重來」，旁邊說明：只清除這個頁面的表單；已交給付款方的那筆仍可能完成，Track 繼續追蹤 | 只清表單；追蹤紀錄、nonce 對帳與收據保留 | 不重送、不廣播；新轉帳仍要等既有的 nonce gate（[`3-architecture.md`](./3-architecture.md) §5 轉帳狀態機） |

按鈕不需要重新整理頁面就能繼續。本頁送出請求後、錢包或 gas 付款方回覆前，「清除重來」與「捨棄」暫時不可用：頁面必須先記下回傳的交易 hash，Track 才追得到這一筆；回覆後依上表顯示。

**捨棄要有 runner 的答案才算**（2026-11-03 補）。已簽 plan 的「捨棄這筆轉帳」與「清除重來」都先請 runner 捨棄，並共用同一組守衛：runner 以 HTTP 錯誤回答（5xx、拒絕）時顯示「未捨棄：runner 沒有確認……」並保留 plan，可再按一次；runner 確認已捨棄、或已不認得這個 plan（404：過期或重啟，表示沒有東西要捨棄）時 plan 才離開頁面；請求在外時，Send、清除、捨棄與 Terminal 交接都暫時不可按，較晚到的答案不會落在之後開啟的新表單上。兩個按鈕對 runner 回答 `unknown`（已被認領的 Terminal 交接；或本頁送出請求後沒收到回應、runner 其實已把它交給付款方）的處理相同（「清除重來」原本不讀這個答案就開新表單，2026-11-03 補修）：把這一筆視為「可能已送出」——頁面顯示結果不明、不再提供 Send，並確保 Track 有它的紀錄（原本就有的紀錄，較早的嘗試或交接寫的，原樣保留；沒有的話用 runner 回傳的紀錄補上，瀏覽器拒絕儲存時說明），Track 把它標成「這一筆」；新表單只在 runner 回 `discarded` 或 404 時才開。保留 plan 的保證也涵蓋傳輸層失敗（同日補修）：捨棄請求連不上 runner（而非 runner 回了錯誤）時，runner 頁把 runner 標成「沒有回應」，目前的 plan、診斷與 gas 付款方（瀏覽器錢包或 runner 的原生簽章器）都留在頁面上，可以再按一次；同一個 runner 再回答後就地繼續。網站頁的配對結束是換了連線而非斷線：診斷、轉帳表單與 plan 作廢，頁面忘掉原本那個 runner 的原生簽章器（狀態、地址、綁定的 keystore 檔）並向新的重新讀；瀏覽器錢包的連線與瀏覽器端 keystore（browser-file）的解鎖狀態不受影響（[`design-ui-ux-guidelines.md`](./design-ui-ux-guidelines.md) §13.4 的連線規則同日改為同一說法）。

**等待中放棄的 Send，runner 要聽到「沒送出」**（2026-11-03 補）。先前一筆的追蹤讀不到時，這筆已簽轉帳等待而不送出（「捨棄」與「清除重來」仍可用）；已開始的 Send 會在錢包或原生簽章器被問到之前放棄，放棄的「沒有東西送出」要讓 runner 聽到——核對恢復前頁面先記著，plan 維持已簽並等待，不重送、錢包不會被問。runner 當時沒有回應，或收到了但回應在路上遺失時，核對恢復後頁面再告訴一次：runner 對「已簽、沒有送出紀錄」的 plan 把同一句話當同一件事，回同一個已簽 plan（不是 409），Send 才能繼續。plan 若在等待期間已作廢（先前那筆核對後確定改變了），遲到的答案不會把它帶回頁面，頁面請 runner 捨棄它。

**結果不明時 hash 只是線索**（PM r30 追加，2026-11-03 補入文件）。送出的結果不確定（錢包回了 hash 或沒回、但 runner 對回報或 relay 的答案遺失）時，Move 顯示結果不明且不再提供 Send。瀏覽器錢包回傳的交易 hash 在回報 runner 之前就先寫進這一筆的追蹤紀錄；瀏覽器拒絕儲存時，本次造訪期間 Track 仍拿這個 hash 去查，頁面說明「未儲存」並顯示 hash。再次寫入不是每次輪詢都做：Track 在鏈上核對出結果（`confirmed`／`final`／`inner-failed`）時才把核對過的 hash 再存一次，存成功後提示消失；在那之前（pending、結果不明）這個線索只在記憶體裡，重新整理會丟失，需要再貼一次。這個 hash 是 Track 到鏈上核對的線索，不是證明：交易若不是 EntryPoint 呼叫、沒有包含這個 UserOp，或包含的 UserOp 與記錄的意圖／nonce 不同，Track 不給收據、也不把它當成失敗——事件搜尋完整做完而別處也沒找到這個 UserOp 時回答「不是這筆轉帳」（忽略這個 hash，繼續依錢包 nonce 追蹤）；事件搜尋被 RPC 拒絕或尚未完成時回答「結果不明」並說明哪裡不符；若在別的交易裡找到這個 UserOp 已執行，就以那筆為準。RPC 拒絕事件搜尋但有 hash 時直接查那筆交易的收據，不再要求貼 hash。

**PM-08 複製**。所有複製入口（Passkey request code、bookmarklet 網址、DevTools helper、runner 配對指令）用同一個複製狀態：

| 規則 | 細節 |
|---|---|
| 內容變了就重來 | 內容（例如新一筆的 request code）改變時，先前的「已複製」清掉 |
| 只認最新一次 | 較早的複製結果晚到時不改變目前的狀態 |
| 失敗要說 | 沒有 Clipboard API、同步例外或被拒絕：顯示失敗與可選取的原文（手動複製），可以再按一次 |
| 不讀剪貼簿 | 只寫入；不保存簽章 |

**PM-09 狀態要對應當前動作**。忙碌超過 20 秒的補充說明依動作而定：模擬（Review、檢查簽章、重新模擬）說「fork 模擬最多約一分鐘，期間不會送出」；送出時說「付款方正在處理，可能已經廣播；Track 會追蹤，不要再送一次」；其他只說「仍在處理」。Track 把「這一筆」和較早的收據分開標示；這一筆在送出中或尚無結果時，Track 的步驟標頭不能因為較早的紀錄都完成而顯示「全部完成」。

### 10.6 驗收

| AC | 證據 |
|---|---|
| PM-01a／b | 自動：`test/unit/ui/gas-stages.test.ts`（每種活動組合）、`test/unit/ui/gas-copy.test.ts`（EN／繁中鍵）、`test/e2e/gas-runtime-ux.spec.ts`（`data-state='input'`、等待 1Password 的文字） |
| PM-01c | 自動：`test/unit/ui/stepWords.test.ts` 的 `deployWord`、`test/e2e/flow.spec.ts`（Continue the transfer、Following the chain、送出前 Deploy「Your turn」） |
| PM-02a／b | 自動：`gas-runtime-ux.spec.ts` 的 390×844 測試（標題與下一個欄位在畫面內、Change 聚焦、方向鍵切換、五種方式、窄版收合／寬版展開、320 reflow）與 1440／768／390 版面測試；實跑：390×844 EN／繁中量測與截圖 |
| PM-03a～d | 自動：`test/e2e/site.spec.ts`（首頁順序、通道收合、footer 連結、Demo 逐張且未看的不載入）、`test/e2e/atlas.spec.ts`（主圖與三圖板座標、播放、reduced motion、Demo 四張逐一載入）、`test/integration/deploy.test.ts`（`needsEvidence`）、`flow.spec.ts`（補上建立資料聚焦輸入）、`test/unit/ui/atlas-assets.test.ts`（重拍後的 SHA-256）、`test/unit/ui/site-copy.test.ts`（轄區圖的私鑰與 Passkey 說法）；實跑：`budget-home.mjs`／`perf-home.mjs`；檢視：新舊截圖 |
| PM-04 | 自動：`site.spec.ts` 模式說明測試（runner 4177、https 4179、http 4180 × 三個內頁）、Download 的 `--allow-origin` 只在 https |
| PM-05 | 自動：`site.spec.ts` Download 測試（尚未發布、建置指令、無 git clone、未來網址是文字、主體不連 repo）；實跑：`pack-smoke.mjs`、`preview-smoke.mjs` |
| PM-06 | 自動：`test/e2e/flow.spec.ts`「PM-06/07/08」（成功後自動重新讀取；「再來一筆」時讀取中不可 Review、輸入保留；新的餘額比第一筆前少 1.5 USDT0 且區塊較新；超額不可 Review；讀取失敗顯示原因與舊區塊、「再試一次」；較早的回應晚到不覆蓋）、`test/e2e/gas-payers.spec.ts`（整個 runner 停止回應時「重新讀取餘額」立即顯示失敗與原因、Review 不可按、輸入保留；runner 回來後再讀一次即為新鮮）、`test/unit/ui/balanceRead.test.ts`（哪些結果觸發讀取、哪個回應套用、超額判斷） |
| PM-07 | 自動：`flow.spec.ts`（成功→「再來一筆」EN／繁中；已簽未送出的「清除重來」：捨棄、不送出、說明簽章不會在鏈上撤銷；結果不明→「清除重來」與說明；清除後不重新整理即可繼續；runner 回 503 時「清除重來」與「捨棄」都保留 plan、顯示未捨棄、請求在外時 Send／清除／捨棄／交接不可按；404 時照常清除、沒有錯誤；send-request 的回應遺失後按「捨棄」→ runner 回 `unknown` → 顯示結果不明、Track 有這一筆的紀錄且標成「這一筆」、重新整理後仍在、錢包未被要求；「清除重來」讀 runner 的 `unknown`：已追蹤、不開新表單、拒存時說明；先前一筆追蹤讀不到時已簽 plan 等待而非作廢、確認視窗的 Send 一併停用；等待中放棄的 Send 與整個 runner 停止回應時放棄的 Send 都保留 plan、runner 回來後聽到「沒送出」；該回報的回應遺失 → 核對恢復後再告知、runner 回同一個已簽 plan、Send 繼續；回報未答時按「捨棄」只等那一個答案；交接碼建立中遇到等待 → 不顯示碼並捨棄、捨棄失敗時保留）、`gas-payers.spec.ts`（picked-keystore 付款方：整個 runner 停止回應時已簽 plan 與付款方保留、再回答後繼續；原生 1Password 付款方：等待中放棄的 Send，runner 在先前一筆確定改變後才回答 → plan 作廢、遲到答案不帶回；runner 沒聽到 → 保持已簽等待，恢復後再告知、Send 經簽章器到收據且只 relay 一次）、`test/unit/server/transfer-relay.test.ts`（「沒送出」說兩次 → 同一個已簽 plan、仍可發 send-request；已送出／已捨棄 → 409）、390 px 版面 |
| PM r30 追加（hash 線索） | 自動：`test/unit/server/track-bundle.test.ts`（都在「RPC 拒絕事件搜尋」的情境下：有 hash → 由收據核對；沒有 hash → 結果不明並要求貼 hash；有 hash 但交易不含這個 UserOp／UserOp 與記錄的意圖不同 → 因搜尋被拒而結果不明、無收據、說明哪裡不符）、`flow.spec.ts`（nonce 1：瀏覽器持續拒絕儲存 hash 時多次輪詢都帶 hash、「未儲存」提示與 hash 顯示、恢復儲存後提示消失且 hash 已存；nonce 2：錢包沒回 hash 且回報的答案遺失 → 結果不明、不提供 Send、紀錄保留、Track 之後找到它） |
| PM-08 | 自動：`flow.spec.ts`（第二筆的 request code 與 bookmarklet 網址：成功、拒絕、無 API、同步例外、亂序只認最新、重試；DevTools helper 被拒時的手動原文；新的 request 不沿用「已複製」）、`test/e2e/ux-behaviours.spec.ts`（配對指令：拒絕、無 API、手動原文、重試） |
| PM-09 | 自動：`test/unit/ui/stepWords.test.ts`（這一筆尚無紀錄或未定案時 Track 不是「全部完成」）、`flow.spec.ts`（送出超過 20 秒的說明不提模擬 EN／繁中；送出中 Track 標頭不是「全部完成」；Track 分開標示這一筆與較早的轉帳） |
