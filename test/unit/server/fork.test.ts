// ForkManager startup failures must surface as ForkError, never as an uncaught child-process error.
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { Fork, ForkError, ForkManager } from '../../../server/fork';

describe('ForkManager startup', () => {
  it('a missing anvil binary rejects with ForkError (ENOENT) and the queue keeps working', async () => {
    const m = new ForkManager({ anvilBin: '/nonexistent/cbpr-anvil', upstreamProxyUrl: `http://127.0.0.1:9/${'ab'.repeat(16)}`, hardfork: 'prague' });
    await expect(m.run({ block: 1n, blockHash: '0x01' }, async () => 'never')).rejects.toSatisfy((e: unknown) => e instanceof ForkError && /could not be started \(ENOENT\)/.test((e as Error).message));
    await expect(m.run({ block: 1n, blockHash: '0x01' }, async () => 'never')).rejects.toBeInstanceOf(ForkError);
  });
});

describe('Fork.close', () => {
  const sleeper = () => spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });

  it('a child already killed by a signal (exitCode null, signalCode set) → close resolves at once', async () => {
    const proc = sleeper();
    await new Promise((r) => proc.once('spawn', r));
    proc.kill('SIGKILL');
    await once(proc, 'exit');
    expect(proc.exitCode).toBeNull();
    expect(proc.signalCode).toBe('SIGKILL');
    const fork = new Fork('http://127.0.0.1:9', 1n, proc);
    await expect(Promise.race([fork.close().then(() => 'closed'), new Promise((r) => setTimeout(() => r('hung'), 1000))])).resolves.toBe('closed');
  });

  it('a running child → close terminates it and resolves; a second close is a no-op', async () => {
    const proc = sleeper();
    await new Promise((r) => proc.once('spawn', r));
    const fork = new Fork('http://127.0.0.1:9', 1n, proc);
    await fork.close();
    expect(proc.signalCode).toBe('SIGTERM');
    await expect(fork.close()).resolves.toBeUndefined();
  });

  it('no process → close resolves', async () => {
    await expect(new Fork('http://127.0.0.1:9', 1n, null).close()).resolves.toBeUndefined();
  });
});
