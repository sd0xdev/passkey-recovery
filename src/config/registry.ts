// Supported deployment registry (M3). The tool works on any wallet of a supported (family, version,
// chain) combination, never on one hard-coded account: every account address, owner set, recipient,
// asset and amount comes from the user and is verified against this table and the chain.
// One combination is supported today: Coinbase Smart Wallet v1.1 × Plasma (9745). Adding one is a
// security change — the code hashes below are what "this is the contract we reviewed" means.
import { getAddress, type Address, type Hex } from 'viem';

export interface AssetInfo {
  /** 'native' or the token contract address (checksummed). */
  id: 'native' | Address;
  symbol: string;
  decimals: number;
  /** Native only: the fee asset (EntryPoint prefund, outer gas). */
  native: boolean;
}

export interface SupportedDeployment {
  id: string;
  family: 'coinbase-smart-wallet';
  version: '1.1';
  chainId: number;
  chainName: string;
  entryPoint: Address;
  singletonFactory: Address;
  implementation: Address;
  factory: Address;
  /** keccak256 of runtime code. walletProxy is the ERC-1967 proxy every factory-made wallet carries. */
  codeHash: { entryPoint: Hex; singletonFactory: Hex; implementation: Hex; factory: Hex; walletProxy: Hex };
  /** factory.initCodeHash(): the CREATE2 bytecode hash of every wallet proxy (salt = keccak256(abi.encode(owners, nonce))). */
  proxyInitCodeHash: Hex;
  /** Public bytecode registry holding the deterministic implementation/factory deployments (sha256 of the file). */
  bytecodeRegistry: { path: string; sha256: string };
  assets: AssetInfo[];
  /** Confirmations after which the tool calls a transfer final (a tool setting, not a chain guarantee). */
  finalityDepth: number;
  /** Passkey owners of Coinbase Smart Wallet sign through this RP (keys.coinbase.com). */
  rp: { id: string; origin: string; entryUrl: string };
  /** Upper bound on owner slots the diagnosis reads (nextOwnerIndex beyond this → unsupported). */
  maxOwners: number;
}

export const ERC1967_IMPLEMENTATION_SLOT: Hex = '0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc';
/** RIP-7212 P256VERIFY address; Plasma has none, so wallets fall back to the FCL Solidity verifier. */
export const P256_PRECOMPILE: Address = '0x0000000000000000000000000000000000000100';

export const SUPPORTED: readonly SupportedDeployment[] = [
  {
    id: 'cbsw-v1.1@9745',
    family: 'coinbase-smart-wallet',
    version: '1.1',
    chainId: 9745,
    chainName: 'Plasma',
    entryPoint: '0x5FF137D4b0FDCD49DcA30c7CF57E578a026d2789',
    singletonFactory: '0x914d7Fec6aaC8cd542e72Bca78B30650d45643d7',
    implementation: '0x00000110dCdEdC9581cb5eCB8467282f2926534d',
    factory: '0xBA5ED110eFDBa3D005bfC882d75358ACBbB85842',
    codeHash: {
      // Read from Plasma 2026-10-31 (EntryPoint v0.6, Safe Singleton Factory).
      entryPoint: '0xc93c806e738300b5357ecdc2e971d6438d34d8e4e17b99b758b1f9cac91c8e70',
      singletonFactory: '0x2fa86add0aed31f33a762c9d88e807c475bd51d0f52bd0955754b2608f7e4989',
      // Runtime code after replaying the registry transactions on a fork (equal on every chain).
      implementation: '0x136185896fc519277ec953c0b3d048fc0c9f607b8d04022e60f23ef8dbc6c4d5',
      factory: '0xb60a629aa7c6af9b550871fd21b67ab84638156683cec68491049cb5d235ed2f',
      walletProxy: '0xaaa52c8cc8a0e3fd27ce756cc6b4e70c51423e9b597b11f32d3e49f8b1fc890d',
    },
    proxyInitCodeHash: '0xa53d9968113cdf38ec78edc985b30bcb1a274ddaa221624c1d15604f70b0761a',
    bytecodeRegistry: { path: 'registry/coinbase-smart-wallet-v1.1/infra-deployment.json', sha256: '618f0306eee3142186a43bc92992787ba1616436976ff39f87da92758ea50a69' },
    assets: [
      { id: 'native', symbol: 'XPL', decimals: 18, native: true },
      { id: '0xB8CE59FC3717ada4C02eaDF9682A9e934F625ebb', symbol: 'USDT0', decimals: 6, native: false },
    ],
    finalityDepth: 12,
    rp: { id: 'keys.coinbase.com', origin: 'https://keys.coinbase.com', entryUrl: 'https://keys.coinbase.com/connect' },
    maxOwners: 16,
  },
];

export function supportedFor(chainId: number): SupportedDeployment | null {
  return SUPPORTED.find((d) => d.chainId === chainId) ?? null;
}

export function assetOf(dep: SupportedDeployment, id: string): AssetInfo | null {
  if (id === 'native') return dep.assets.find((a) => a.native) ?? null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(id)) return null;
  const a = getAddress(id.toLowerCase());
  return dep.assets.find((x) => x.id !== 'native' && getAddress(x.id) === a) ?? null;
}

export const tokenAssets = (dep: SupportedDeployment) => dep.assets.filter((a): a is AssetInfo & { id: Address } => a.id !== 'native');
export const nativeAsset = (dep: SupportedDeployment) => dep.assets.find((a) => a.native)!;

/** Contracts a transfer must never target as recipient (would burn funds or call infrastructure). */
export function infraAddresses(dep: SupportedDeployment): Address[] {
  return [dep.entryPoint, dep.singletonFactory, dep.implementation, dep.factory, P256_PRECOMPILE, ...tokenAssets(dep).map((a) => a.id)].map((a) => getAddress(a));
}
