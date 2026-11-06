// Public bytecode registry (M3, release addendum): the deterministic implementation/factory deployments
// come from a de-personalised file in registry/, pinned by sha256 in src/config/registry.ts. Each step's
// CREATE2 target is recomputed from (singleton, salt, initcode) and must be the registry address; any
// mismatch throws, so altered bytecode can never be planned. Nothing here reads the private research.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getAddress, getContractAddress, keccak256, slice, type Address, type Hex } from 'viem';
import type { SupportedDeployment } from '../src/config/registry';

export class RegistryError extends Error {
  override name = 'RegistryError';
}

export type InfraTarget = 'implementation' | 'factory';

export interface InfraStep {
  target: InfraTarget;
  to: Address;
  data: Hex;
  /** Address whose runtime code this step creates. */
  creates: Address;
  source: { chainId: number; txHash: Hex; blockNumber: number };
}

interface RegistryFile {
  format: string;
  version: string;
  steps: Array<{ target: string; source: { chainId: number; txHash: string; blockNumber: number }; to: string; value: string; input: string }>;
}

export function loadInfraSteps(dep: SupportedDeployment, root: string = process.cwd()): InfraStep[] {
  let buf: Buffer;
  try {
    buf = readFileSync(join(root, dep.bytecodeRegistry.path));
  } catch {
    throw new RegistryError(`bytecode registry ${dep.bytecodeRegistry.path} missing`);
  }
  if (createHash('sha256').update(buf).digest('hex') !== dep.bytecodeRegistry.sha256) throw new RegistryError('bytecode registry sha256 does not match the pinned value');
  const j = JSON.parse(buf.toString('utf8')) as RegistryFile;
  if (j.format !== 'cbpr-bytecode-registry-v1' || !Array.isArray(j.steps) || j.steps.length !== 2) throw new RegistryError('bytecode registry format');
  const want: Record<InfraTarget, Address> = { implementation: getAddress(dep.implementation), factory: getAddress(dep.factory) };
  return j.steps.map((s, i) => {
    if (s.target !== 'implementation' && s.target !== 'factory') throw new RegistryError(`step ${i}: unknown target`);
    if (getAddress(s.to) !== getAddress(dep.singletonFactory)) throw new RegistryError(`step ${i}: not sent to the Safe Singleton Factory`);
    if (BigInt(s.value) !== 0n) throw new RegistryError(`step ${i}: carries value`);
    const input = s.input.toLowerCase() as Hex;
    if (!/^0x[0-9a-f]+$/.test(input) || input.length < 2 + 64 + 2) throw new RegistryError(`step ${i}: input malformed`);
    const predicted = getContractAddress({ opcode: 'CREATE2', from: dep.singletonFactory, salt: slice(input, 0, 32), bytecodeHash: keccak256(slice(input, 32)) });
    if (predicted !== want[s.target]) throw new RegistryError(`step ${i}: CREATE2 address ${predicted} is not ${want[s.target]}`);
    if (!/^0x[0-9a-f]{64}$/.test(s.source.txHash)) throw new RegistryError(`step ${i}: source txHash`);
    return { target: s.target, to: getAddress(dep.singletonFactory), data: input, creates: predicted, source: { chainId: s.source.chainId, txHash: s.source.txHash as Hex, blockNumber: s.source.blockNumber } };
  });
}
