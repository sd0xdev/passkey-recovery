// Deployment truth is state, never a receipt (tech spec §3.3, M3): code hashes, the ERC-1967 slot and the
// owner set must all match before an account counts as a supported, deployed wallet. A non-empty
// mismatching code anywhere is a hard stop — the tool never deploys over, around or next to unexpected code.
import { getAddress, type Address, type Hex } from 'viem';
import type { SupportedDeployment } from '../src/config/registry';
import type { OwnerSlot } from './reader';

export interface StateView {
  infraCode: { entryPoint: Hex | null; singletonFactory: Hex | null; implementation: Hex | null; factory: Hex | null };
  accountCode: Hex | null;
  accountImplementation: Address | null;
  owners: OwnerSlot[] | null;
  nextOwnerIndex: bigint | null;
  removedOwnersCount: bigint | null;
}

export type TargetState = 'absent' | 'present' | 'mismatch';

export type StopCode = 'infra-missing' | 'unknown-code' | 'wrong-implementation' | 'owners-unreadable' | 'owner-mismatch' | 'too-many-owners';

export interface Stop {
  code: StopCode;
  detail: string;
}

export interface DeploymentVerdict {
  infra: { entryPoint: boolean; singletonFactory: boolean };
  targets: { implementation: TargetState; factory: TargetState; account: TargetState };
  /** Account code is the v1.1 proxy, its slot points at the v1.1 implementation and its owners are readable. */
  accountVerified: boolean;
  stops: Stop[];
  /** Everything needed to sign for this account is on chain and verified. */
  complete: boolean;
}

const same = (a: Hex | null, b: Hex) => a !== null && a.toLowerCase() === b.toLowerCase();

/** `expectedOwners`: when the owners are known from derivation evidence, a deployed account must carry exactly them. */
export function deploymentVerdict(dep: SupportedDeployment, v: StateView, expectedOwners?: readonly Hex[]): DeploymentVerdict {
  const stops: Stop[] = [];
  const infra = { entryPoint: same(v.infraCode.entryPoint, dep.codeHash.entryPoint), singletonFactory: same(v.infraCode.singletonFactory, dep.codeHash.singletonFactory) };
  if (!infra.entryPoint) stops.push({ code: 'infra-missing', detail: 'EntryPoint v0.6 code is missing or differs from the reviewed hash' });
  if (!infra.singletonFactory) stops.push({ code: 'infra-missing', detail: 'Safe Singleton Factory code is missing or differs from the reviewed hash' });
  const t = (h: Hex | null, want: Hex): TargetState => (h === null ? 'absent' : same(h, want) ? 'present' : 'mismatch');
  const targets = {
    implementation: t(v.infraCode.implementation, dep.codeHash.implementation),
    factory: t(v.infraCode.factory, dep.codeHash.factory),
    account: t(v.accountCode, dep.codeHash.walletProxy),
  };
  if (targets.implementation === 'mismatch') stops.push({ code: 'unknown-code', detail: 'the v1.1 implementation address holds unexpected code — stop, do not deploy' });
  if (targets.factory === 'mismatch') stops.push({ code: 'unknown-code', detail: 'the v1.1 factory address holds unexpected code — stop, do not deploy' });
  if (targets.account === 'mismatch') stops.push({ code: 'unknown-code', detail: 'the account holds code that is not a Coinbase Smart Wallet v1.1 proxy — unsupported' });
  let accountVerified = false;
  if (targets.account === 'present') {
    const okImpl = v.accountImplementation !== null && getAddress(v.accountImplementation) === getAddress(dep.implementation);
    if (!okImpl) stops.push({ code: 'wrong-implementation', detail: 'the account ERC-1967 implementation slot is not v1.1 (upgraded or another version) — unsupported' });
    if (targets.implementation !== 'present') stops.push({ code: 'wrong-implementation', detail: 'the account exists but the v1.1 implementation is not deployed on this chain' });
    const ownersOk = v.owners !== null && v.nextOwnerIndex !== null && v.removedOwnersCount !== null;
    if (!ownersOk) stops.push({ code: 'owners-unreadable', detail: 'owner slots could not be read' });
    else if (v.nextOwnerIndex! > BigInt(dep.maxOwners)) stops.push({ code: 'too-many-owners', detail: `more than ${dep.maxOwners} owner slots — unsupported by this tool` });
    if (ownersOk && expectedOwners) {
      const live = v.owners!.map((o) => o.bytes.toLowerCase());
      const want = expectedOwners.map((o) => o.toLowerCase());
      if (v.removedOwnersCount !== 0n || live.length !== want.length || live.some((o, i) => o !== want[i])) stops.push({ code: 'owner-mismatch', detail: 'on-chain owners differ from the derivation evidence (owners changed after creation, or wrong evidence)' });
    }
    accountVerified = okImpl && targets.implementation === 'present' && ownersOk && !stops.some((s) => s.code === 'owner-mismatch' || s.code === 'too-many-owners');
  }
  return { infra, targets, accountVerified, stops, complete: accountVerified && stops.length === 0 };
}
