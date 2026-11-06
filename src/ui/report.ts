// AI-assist report (M4): a redacted JSON the user may paste into any AI assistant to get help reading
// a diagnosis or a stuck transfer. Built from an explicit allowlist — never by serialising app state —
// so it cannot carry an assertion, a signature, a signed UserOp, a public key, an RPC URL or a key.
// Every address or hash that does appear is cut to its first and last 6 characters.
export const REPORT_FORMAT = 'cbpr-ai-report-v1';

/** Any 0x hex run of 40+ digits → first 6 + last 6; URLs → "[url]". Applied to every free-text field. */
export function redactText(s: string): string {
  return s
    .replace(/https?:\/\/[^\s"')]+/gi, '[url]')
    .replace(/0x[0-9a-fA-F]{40,}/g, (m) => `${m.slice(0, 6)}…${m.slice(-6)}`)
    .slice(0, 400);
}

export const redactAddress = (a: string | null | undefined) => (a ? redactText(a) : null);

export interface ReportInput {
  generatedAt: string;
  mode: string | null;
  chain: { chainId: number; name: string; deploymentId: string };
  rpc: { source: string; overall: string; capabilities: Array<{ id: string; status: string }> } | null;
  wallet: { connected: boolean; chainId: number | null } | null;
  /** Which kind of gas payer is chosen and whether it is ready — never its key, link, item or file name. */
  gasPayer?: { mode: string; ready: boolean };
  diagnosis: {
    account: string;
    supported: boolean;
    block: string;
    checks: Array<{ id: string; ok: boolean; detail: string }>;
    blockers: string[];
    needs: string[];
    passkeyOwnerIndexes: number[];
    nonce: string;
  } | null;
  deploy: { steps: Array<{ key: string; state: string; status?: string }>; complete: boolean } | null;
  transfer: {
    state: string;
    asset: string;
    amount: string;
    recipient: string;
    nonce: string;
    ownerIndex: number;
    signable: boolean;
    notSignableReason: string | null;
    signedSim: { success: boolean; problems: string[] } | null;
    sendOutcome: string | null;
  } | null;
  tracks: Array<{ state: string; detail: string; confirmations: string | null; asset: string; amount: string }>;
  lastError: string | null;
}

export function buildReport(i: ReportInput) {
  const d = i.diagnosis;
  const tr = i.transfer;
  return {
    format: REPORT_FORMAT,
    note: 'Redacted status report from Passkey Recovery by sd0x (local tool). It contains no signature, key or RPC URL. An assistant can explain it and suggest next steps; it cannot sign or send anything, and only the user acts in the app.',
    generatedAt: i.generatedAt,
    mode: i.mode,
    chain: { chainId: i.chain.chainId, name: i.chain.name, deploymentId: i.chain.deploymentId },
    rpc: i.rpc && { source: i.rpc.source, overall: i.rpc.overall, capabilities: i.rpc.capabilities.map((c) => ({ id: c.id, status: c.status })) },
    browserWallet: i.wallet && { connected: i.wallet.connected, chainId: i.wallet.chainId },
    gasPayer: i.gasPayer ?? null,
    diagnosis: d && {
      account: redactAddress(d.account),
      supported: d.supported,
      block: d.block,
      checks: d.checks.map((c) => ({ id: c.id, ok: c.ok, detail: redactText(c.detail) })),
      blockers: d.blockers.map(redactText),
      needs: [...d.needs],
      passkeyOwnerIndexes: [...d.passkeyOwnerIndexes],
      userOpNonce: d.nonce,
    },
    deploy: i.deploy && { complete: i.deploy.complete, steps: i.deploy.steps.map((s) => ({ key: s.key, state: s.state, ...(s.status ? { status: s.status } : {}) })) },
    transfer: tr && {
      state: tr.state,
      asset: tr.asset,
      amount: tr.amount,
      recipient: redactAddress(tr.recipient),
      nonce: tr.nonce,
      ownerIndex: tr.ownerIndex,
      signable: tr.signable,
      notSignableReason: tr.notSignableReason && redactText(tr.notSignableReason),
      signedSim: tr.signedSim && { success: tr.signedSim.success, problems: tr.signedSim.problems.map(redactText) },
      sendOutcome: tr.sendOutcome,
    },
    tracks: i.tracks.map((t) => ({ state: t.state, detail: redactText(t.detail), confirmations: t.confirmations, asset: t.asset, amount: t.amount })),
    lastError: i.lastError && redactText(i.lastError),
  };
}
