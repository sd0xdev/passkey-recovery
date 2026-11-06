// 1Password CLI adapter: reads the keystore password into memory via `op read <reference>`. The
// reference (not secret) is the only argv; stdout is captured, never echoed; stderr stays the user's
// (op may ask for unlock there). Tests inject a fake adapter; the real one refuses odd references.
import { spawn } from 'node:child_process';

export interface OpAdapter {
  readPassword(reference: string): Promise<string>;
}

export const OP_REF_RE = /^op:\/\/[a-z0-9]{26}\/[a-z0-9]{26}\/password$/;

export class OpError extends Error {
  override name = 'OpError';
}

export function realOp(bin = 'op'): OpAdapter {
  return {
    readPassword(reference) {
      if (!OP_REF_RE.test(reference)) return Promise.reject(new OpError('password reference has an unexpected shape'));
      return new Promise((resolve, reject) => {
        const p = spawn(bin, ['read', '--no-newline', reference], { stdio: ['inherit', 'pipe', 'inherit'] });
        const chunks: Buffer[] = [];
        p.stdout.on('data', (c: Buffer) => chunks.push(c));
        p.on('error', () => reject(new OpError('could not run the 1Password CLI (op)')));
        p.on('close', (code) => {
          const buf = Buffer.concat(chunks);
          const s = buf.toString('utf8');
          buf.fill(0);
          if (code !== 0 || s.length === 0) reject(new OpError(`op read failed (exit ${code})`));
          else resolve(s);
        });
      });
    },
  };
}
