// Bilingual copy (design guidelines §10): English is the default, 繁中 is a toggle. RPC settings copy
// lives here; the M4 logbook copy is in ./copy.ts and merged below.
// The choice lives in React state only — never in storage or the URL — so a reload returns to English.
import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { APP_EN, APP_ZH } from './copy';
import { UX_EN, UX_ZH } from './copy-ux';
import { SITE_EN, SITE_ZH } from './site/copy-site';

export type Lang = 'en' | 'zh-Hant-TW';

const RPC_EN = {
  'lang.toggle': '繁中',
  'lang.toggleLabel': 'Show this page in Traditional Chinese',
  'rpc.title': 'RPC endpoint',
  'rpc.lead': 'Every balance, check and simulation reads the chain through this endpoint. Sending never does: your own wallet broadcasts through its own RPC.',
  'rpc.noSidecar': 'This page is not served by the local sidecar (npm start), so the endpoint cannot be checked or changed here. The default is the public Plasma RPC.',
  'rpc.loading': 'Reading the current endpoint…',
  'rpc.active': 'In use: {source}',
  'rpc.source.default': 'Public default',
  'rpc.source.file': 'Set by CBPR_RPC_URL_FILE when the sidecar started',
  'rpc.source.testchain': 'Synthetic testchain (local anvil)',
  'rpc.source.custom': 'Your RPC, for this page only',
  'rpc.status.ready': 'Ready for checks and simulation',
  'rpc.status.limited': 'Readable, but not every check can run here',
  'rpc.status.failed': 'Not usable',
  'rpc.status.unchecked': 'Not checked yet',
  'rpc.check': 'Check this endpoint',
  'rpc.checking': 'Checking… a fork simulation can take up to a minute',
  'rpc.log.title': 'What this endpoint can do',
  'rpc.log.at': 'Checked at block {block}, {age}s after it was produced',
  'rpc.log.empty': 'No check has run against this endpoint yet.',
  'cap.chain': 'Right chain',
  'cap.read': 'Reads state',
  'cap.consistency': 'Same answer twice',
  'cap.estimate': 'Estimates gas',
  'cap.stateOverride': 'Accepts state overrides',
  'cap.fork': 'Local fork simulation',
  'cap.archive': 'Older blocks',
  'cap.broadcast': 'Broadcast',
  'status.ok': 'Yes',
  'status.unsupported': 'No',
  'status.error': 'Failed',
  'status.skipped': 'Skipped',
  'status.not-probed': 'Never tested',
  'rpc.busy': 'The RPC is busy (rate limited {n} times). Requests are retried up to 3 times; if this keeps happening, use your own RPC below.',
  'rpc.custom.title': 'Use your own RPC',
  'rpc.custom.lead': 'Paste the full URL from your provider, including any key in it. It is masked everywhere after you press Use.',
  'rpc.custom.label': 'RPC URL',
  'rpc.custom.session': 'The URL stays in this computer’s memory for this page only. Reloading the page or pressing Clear removes it; it is never saved to disk, the address bar or browser storage.',
  'rpc.custom.discard': 'Switching endpoints, or checking one again, discards any transfer you have not handed to the Terminal yet.',
  'rpc.custom.local': 'This is my own node, on this computer or my local network',
  'rpc.custom.localHelp': 'Addresses like 127.0.0.1, 192.168.x.x or a .lan name are refused unless you confirm. Cloud metadata and other reserved addresses are always refused.',
  'rpc.custom.phrase': 'Type {phrase} to confirm',
  'rpc.test': 'Test',
  'rpc.use': 'Use this RPC',
  'rpc.clear': 'Clear and go back to the default',
  'rpc.testing': 'Testing…',
  'rpc.using': 'Checking and switching…',
  'rpc.tested': 'Test result for {host} (not in use)',
  'rpc.used': 'Now using {host}',
  'rpc.cleared': 'Cleared. Back to the default endpoint.',
  'rpc.localBanner': 'You are reading the chain from your own node at {host}. Results are only as trustworthy as that node.',
  'rpc.error': 'Not changed: {reason}',
} as const;

const EN = { ...RPC_EN, ...APP_EN, ...UX_EN, ...SITE_EN };
export type MsgKey = keyof typeof EN;

const RPC_ZH: Record<keyof typeof RPC_EN, string> = {
  'lang.toggle': 'English',
  'lang.toggleLabel': 'Show this page in English',
  'rpc.title': 'RPC 端點',
  'rpc.lead': '所有餘額、檢查與模擬都經由這個端點讀取鏈上資料。送出交易不經過它：由你自己的錢包透過它自己的 RPC 廣播。',
  'rpc.noSidecar': '本頁不是由本機 sidecar（npm start）提供，無法在這裡檢查或更換端點。預設為公開的 Plasma RPC。',
  'rpc.loading': '正在讀取目前的端點…',
  'rpc.active': '使用中：{source}',
  'rpc.source.default': '公開預設',
  'rpc.source.file': 'sidecar 啟動時由 CBPR_RPC_URL_FILE 指定',
  'rpc.source.testchain': '合成測試鏈（本機 anvil）',
  'rpc.source.custom': '你的 RPC，只用於本頁',
  'rpc.status.ready': '可進行檢查與模擬',
  'rpc.status.limited': '可讀取，但部分檢查無法在這裡執行',
  'rpc.status.failed': '無法使用',
  'rpc.status.unchecked': '尚未檢查',
  'rpc.check': '檢查這個端點',
  'rpc.checking': '檢查中…fork 模擬最多約一分鐘',
  'rpc.log.title': '這個端點能做什麼',
  'rpc.log.at': '於區塊 {block} 檢查，距該區塊產生 {age} 秒',
  'rpc.log.empty': '尚未對這個端點執行檢查。',
  'cap.chain': '鏈正確',
  'cap.read': '可讀取狀態',
  'cap.consistency': '兩次回答一致',
  'cap.estimate': '可估算 gas',
  'cap.stateOverride': '支援 state override',
  'cap.fork': '本機 fork 模擬',
  'cap.archive': '較舊的區塊',
  'cap.broadcast': '廣播',
  'status.ok': '是',
  'status.unsupported': '否',
  'status.error': '失敗',
  'status.skipped': '略過',
  'status.not-probed': '從不測試',
  'rpc.busy': 'RPC 忙碌中（已被限流 {n} 次）。每個請求最多重試 3 次；若持續發生，請在下方改用你自己的 RPC。',
  'rpc.custom.title': '使用你自己的 RPC',
  'rpc.custom.lead': '貼上服務商給你的完整 URL（包含其中的 key）。按下「使用」後，各處都只顯示遮罩後的形式。',
  'rpc.custom.label': 'RPC URL',
  'rpc.custom.session': 'URL 只存在這台電腦的記憶體、只用於本頁。重新整理頁面或按「清除」即移除；不會寫入磁碟、網址列或瀏覽器儲存空間。',
  'rpc.custom.discard': '切換端點或重新檢查端點，都會捨棄所有尚未交給 Terminal 的轉帳。',
  'rpc.custom.local': '這是我自己的節點，在這台電腦或我的區域網路上',
  'rpc.custom.localHelp': '127.0.0.1、192.168.x.x 或 .lan 名稱等位址，未經你確認一律拒絕。雲端 metadata 與其他保留位址永遠拒絕。',
  'rpc.custom.phrase': '輸入 {phrase} 以確認',
  'rpc.test': '測試',
  'rpc.use': '使用這個 RPC',
  'rpc.clear': '清除並回到預設',
  'rpc.testing': '測試中…',
  'rpc.using': '檢查並切換中…',
  'rpc.tested': '{host} 的測試結果（未使用）',
  'rpc.used': '已改用 {host}',
  'rpc.cleared': '已清除，回到預設端點。',
  'rpc.localBanner': '你正從自己位於 {host} 的節點讀取鏈上資料。結果的可信度取決於該節點。',
  'rpc.error': '未變更：{reason}',
};

const ZH: Record<MsgKey, string> = { ...RPC_ZH, ...APP_ZH, ...UX_ZH, ...SITE_ZH };

export const MESSAGES: Record<Lang, Record<MsgKey, string>> = { en: EN, 'zh-Hant-TW': ZH };

/** For keys built at run time (server shapes, error codes): only a key both languages have is a MsgKey. */
export function hasMessage(k: string): k is MsgKey {
  return Object.hasOwn(MESSAGES.en, k) && Object.hasOwn(MESSAGES['zh-Hant-TW'], k);
}

export function format(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

type Ctx = { lang: Lang; setLang: (l: Lang) => void; t: (k: MsgKey, vars?: Record<string, string | number>) => string };
const LangContext = createContext<Ctx | null>(null);

export function LangProvider({ children, initial = 'en' }: { children: ReactNode; initial?: Lang }) {
  const [lang, setLang] = useState<Lang>(initial);
  const t = (k: MsgKey, vars?: Record<string, string | number>) => format(MESSAGES[lang][k], vars);
  // <html lang> follows the toggle (guidelines §9) so screen readers switch voice.
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  return <LangContext.Provider value={{ lang, setLang, t }}>{children}</LangContext.Provider>;
}

export function useT(): Ctx {
  const c = useContext(LangContext);
  if (!c) throw new Error('useT outside LangProvider');
  return c;
}
