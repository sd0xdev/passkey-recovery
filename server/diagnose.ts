// Account diagnosis D1–D6 (M3). Works for any account the user names on a supported chain:
//   D1 chain identity (chainId + genesis) and a supported deployment for it
//   D2 infrastructure code (EntryPoint, Safe Singleton Factory; implementation/factory present or deployable)
//   D3 account code: absent (needs deployment) | v1.1 proxy | anything else (unsupported, stop)
//   D4 owners: read from chain when deployed; otherwise from deployment evidence, accepted only when the
//      local CREATE2 derivation equals the account AND factory.getAddress agrees (on chain, or on a fork
//      with the registry infrastructure replayed when the factory is not on this chain yet)
//   D5 owner kinds and which Passkey owners can sign (index + public key)
//   D6 balances, EntryPoint deposit, nonce, and what is still missing
// Missing evidence, an unknown owner or an unsupported version blocks everything after it, with the reason.
import { decodeFunctionResult, encodeFunctionData, getAddress, toHex, type Address, type Hex } from 'viem';
import { tokenAssets, type SupportedDeployment } from '../src/config/registry';
import { parseAddress } from '../src/transfer/intent';
import { classifyOwner, deriveAddress, DeriveError, parseDerivationEvidence, type Derivation, type OwnerInfo } from '../src/wallet/derive';
import { FACTORY_ABI } from './abi';
import type { InfraStep } from './bytecodeRegistry';
import type { ForkManager } from './fork';
import { HttpError } from './http';
import type { AccountSnapshot, OwnerSlot, Reader } from './reader';
import { assertP256Parity, feePolicy, PREVIEW_SENDER, simulateDeploy } from './sim';
import { deploymentVerdict, type DeploymentVerdict } from './state';

export interface Check {
  id: 'D1' | 'D2' | 'D3' | 'D4' | 'D5' | 'D6';
  ok: boolean;
  detail: string;
}

export interface KnownAccount {
  address: Address;
  owners: OwnerSlot[];
  derivation: Derivation | null;
  deployed: boolean;
  /** Snapshot block of the diagnosis that accepted it. */
  block: bigint;
}

export interface Diagnosis {
  account: Address;
  chainId: number;
  deploymentId: string;
  block: bigint;
  checks: Check[];
  verdict: DeploymentVerdict;
  owners: OwnerInfo[] | null;
  passkeyOwners: OwnerInfo[];
  derivation: { source: Derivation['source']; nonce: string; localMatch: boolean; factoryMatch: boolean | null; factoryCheckedOn: 'chain' | 'fork' | null } | null;
  balances: { native: bigint; tokens: Record<Address, bigint | null>; deposit: bigint; nonce: bigint };
  /** What blocks signing, in order; empty when the account is ready for a transfer (after any deployment). */
  blockers: string[];
  /** Deployment work still needed (empty when deployed). */
  needs: Array<'implementation' | 'factory' | 'account'>;
  supported: boolean;
  /** The only thing stopping the check is the missing creation evidence of a not-yet-deployed account: the user
   *  can continue by adding it (the page words this as one more input, not a refusal). */
  needsEvidence: boolean;
}

const MATCH = (a: string, b: string) => getAddress(a) === getAddress(b);

export async function diagnose(
  reader: Reader,
  forks: ForkManager,
  infra: InfraStep[],
  body: Record<string, unknown>,
): Promise<{ diagnosis: Diagnosis; known: KnownAccount | null; snapshot: AccountSnapshot }> {
  const dep: SupportedDeployment = reader.dep;
  let account: Address;
  try {
    account = parseAddress(body.account, 'account');
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
  const snap = await reader.snapshot(account);
  const checks: Check[] = [{ id: 'D1', ok: true, detail: `chain ${snap.chainId} (genesis verified), deployment ${dep.id}` }];
  const blockers: string[] = [];
  const tag = toHex(snap.block);

  // D4 evidence first (needed for D3's owner comparison when deployed with evidence given).
  let derivation: Derivation | null = null;
  const ev = body.evidence as Record<string, unknown> | undefined;
  if (ev && typeof ev === 'object') {
    try {
      derivation = parseDerivationEvidence(dep, ev);
    } catch (e) {
      if (e instanceof DeriveError) throw new HttpError(400, `deployment evidence: ${e.message}`);
      throw e;
    }
  }
  const verdict = deploymentVerdict(dep, snap, snap.accountCode && derivation ? derivation.owners : undefined);
  const infraOk = verdict.infra.entryPoint && verdict.infra.singletonFactory && verdict.targets.implementation !== 'mismatch' && verdict.targets.factory !== 'mismatch';
  checks.push({ id: 'D2', ok: infraOk, detail: infraOk ? `EntryPoint and Safe Singleton Factory verified; implementation ${verdict.targets.implementation}, factory ${verdict.targets.factory}` : verdict.stops.filter((s) => s.code === 'infra-missing' || (s.code === 'unknown-code' && !/account/.test(s.detail))).map((s) => s.detail).join('; ') });
  if (!infraOk) blockers.push('infrastructure on this chain is missing or unexpected');
  const acctState = verdict.targets.account;
  const d3ok = acctState === 'absent' || verdict.accountVerified;
  checks.push({ id: 'D3', ok: d3ok, detail: acctState === 'absent' ? 'no code at the account yet: it must be deployed before it can sign' : verdict.accountVerified ? 'Coinbase Smart Wallet v1.1 proxy, implementation slot verified' : verdict.stops.filter((s) => s.code !== 'infra-missing').map((s) => s.detail).join('; ') });
  if (!d3ok) blockers.push('the account is not a supported Coinbase Smart Wallet v1.1');

  let missingEvidence = false;
  let owners: OwnerSlot[] | null = null;
  let derivInfo: Diagnosis['derivation'] = null;
  if (acctState === 'present' && verdict.accountVerified) {
    owners = snap.owners;
    checks.push({ id: 'D4', ok: true, detail: `${owners!.length} owner slot(s) read from the chain${derivation ? '; matches the evidence' : ''}` });
  } else if (acctState === 'absent') {
    if (!derivation) {
      checks.push({ id: 'D4', ok: false, detail: 'not deployed here: paste the createAccount calldata or initCode from the chain where this account exists, or enter its owners and creation nonce' });
      blockers.push('owners unknown — deployment evidence needed');
      missingEvidence = true;
    } else {
      const local = deriveAddress(dep, derivation.owners, derivation.nonce);
      const localMatch = MATCH(local, account);
      let factoryMatch: boolean | null = null;
      let on: 'chain' | 'fork' | null = null;
      if (localMatch && infraOk) {
        if (verdict.targets.factory === 'present') {
          const r = await reader.readCall({ kind: 'factoryGetAddress', owners: derivation.owners, nonce: derivation.nonce }, tag);
          factoryMatch = MATCH(decodeFunctionResult({ abi: FACTORY_ABI, functionName: 'getAddress', data: r }) as Address, account);
          on = 'chain';
        } else {
          const need = infra.filter((s) => verdict.targets[s.target] === 'absent');
          factoryMatch = await forks.run(snap, async (f) => {
            f.guard({ wallets: [account], entryPoint: dep.entryPoint });
            await assertP256Parity(f, snap.p256Probe);
            await simulateDeploy(f, need.map((s) => ({ key: s.target, to: s.to, data: s.data })), PREVIEW_SENDER, { synthetic: true, fees: feePolicy(snap.baseFee, snap.priorityFee) });
            const r = await f.call(dep.factory, encodeFunctionData({ abi: FACTORY_ABI, functionName: 'getAddress', args: [derivation!.owners, derivation!.nonce] }));
            return MATCH(decodeFunctionResult({ abi: FACTORY_ABI, functionName: 'getAddress', data: r }) as Address, account);
          });
          on = 'fork';
        }
      }
      const ok = localMatch && factoryMatch === true;
      derivInfo = { source: derivation.source, nonce: derivation.nonce.toString(), localMatch, factoryMatch, factoryCheckedOn: on };
      checks.push({ id: 'D4', ok, detail: !localMatch ? `the evidence derives ${local}, not this account: wrong owners, order or nonce` : factoryMatch === null ? 'local derivation matches; the factory check needs working infrastructure' : factoryMatch ? `local CREATE2 and factory.getAddress (${on}) both give this account` : 'factory.getAddress disagrees with the local derivation — stop' });
      if (ok) owners = derivation.owners.map((b, i) => ({ index: i, bytes: b.toLowerCase() as Hex }));
      else blockers.push('deployment evidence does not derive this account');
    }
  } else {
    checks.push({ id: 'D4', ok: false, detail: 'owners not read: account is not a supported wallet' });
  }

  const infos = owners ? owners.map((o) => classifyOwner(o.index, o.bytes)) : null;
  const passkeys = infos?.filter((o) => o.kind === 'passkey') ?? [];
  if (infos) {
    const unknown = infos.filter((o) => o.kind === 'unknown');
    const d5ok = passkeys.length > 0 && unknown.length === 0;
    checks.push({ id: 'D5', ok: d5ok, detail: `${passkeys.length} Passkey owner(s), ${infos.filter((o) => o.kind === 'address').length} address owner(s), ${infos.filter((o) => o.kind === 'removed').length} removed${unknown.length ? `, ${unknown.length} of unknown format` : ''}` });
    if (passkeys.length === 0) blockers.push('no Passkey owner: this tool signs only with a Passkey owner');
    if (unknown.length) blockers.push('an owner has an unknown format — unsupported');
  } else checks.push({ id: 'D5', ok: false, detail: 'owners unknown' });

  const balances = { native: snap.balances.native, tokens: snap.balances.tokens, deposit: snap.deposit, nonce: snap.nonce };
  const tokensRead = tokenAssets(dep).every((t) => snap.balances.tokens[t.id] !== null);
  checks.push({ id: 'D6', ok: tokensRead, detail: `block ${snap.block}: balances${tokensRead ? '' : ' (a token balance was unreadable)'}, EntryPoint deposit and nonce read` });

  const needs: Diagnosis['needs'] = [];
  if (verdict.targets.implementation === 'absent') needs.push('implementation');
  if (verdict.targets.factory === 'absent') needs.push('factory');
  if (acctState === 'absent') needs.push('account');
  const supported = blockers.length === 0;
  const needsEvidence = missingEvidence && blockers.length === 1;
  const diagnosis: Diagnosis = { account, chainId: snap.chainId, deploymentId: dep.id, block: snap.block, checks, verdict, owners: infos, passkeyOwners: passkeys, derivation: derivInfo, balances, blockers, needs, supported, needsEvidence };
  const known: KnownAccount | null = supported && owners ? { address: account, owners, derivation, deployed: acctState === 'present', block: snap.block } : null;
  return { diagnosis, known, snapshot: snap };
}
