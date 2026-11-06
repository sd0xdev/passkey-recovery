// The built UI the sidecar serves, read once when the process starts. A later `npm run build` rewrites dist/
// on disk, but a running runner keeps serving the page it was started with, so the page always matches the
// sidecar and native signer in this process's memory (a rebuilt page against an older signer is what showed
// "unknown endpoint"). Picking up a new build takes a restart, which also restarts the signer.
import { lstatSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** A built UI is well under this; a larger tree is refused instead of being held in memory. */
export const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;

/** Relative POSIX path (e.g. `assets/index-abc.js`) → bytes. Symlinks and anything not a regular file are left out. */
export function snapshotDist(root: string): ReadonlyMap<string, Buffer> {
  const files = new Map<string, Buffer>();
  let total = 0;
  const walk = (dir: string, prefix: string) => {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return; // no build yet: every page request answers 404, as it did before
    }
    for (const name of names.sort()) {
      const abs = join(dir, name);
      const st = lstatSync(abs);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (st.isDirectory()) walk(abs, rel);
      else if (st.isFile()) {
        total += st.size;
        if (total > MAX_SNAPSHOT_BYTES) throw new Error(`the built UI in ${root} is larger than ${MAX_SNAPSHOT_BYTES} bytes`);
        files.set(rel, readFileSync(abs));
      }
    }
  };
  walk(root, '');
  return files;
}
