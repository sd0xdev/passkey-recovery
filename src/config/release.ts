// Where this build comes from and where its runner package is published. The version is read from package.json at build
// time (Vite inlines only the `version` field). The release URLs exist only once the maintainer publishes the GitHub Release
// for this tag; until then the page offers the same file built from source (docs/release/release-plan.md).
import { version } from '../../package.json';

export const VERSION: string = version;
export const REPO_URL = 'https://github.com/sd0xdev/passkey-recovery';
export const RELEASE_TAG = `v${VERSION}`;
export const TARBALL = `passkey-recovery-${VERSION}.tgz`;
export const RELEASE_PAGE_URL = `${REPO_URL}/releases/tag/${RELEASE_TAG}`;
export const TARBALL_URL = `${REPO_URL}/releases/download/${RELEASE_TAG}/${TARBALL}`;

/** The runner pairs only with exact https origins: an http page (a local preview) is never offered as one. */
export const pairableOrigin = (origin: string): string | undefined => (origin.startsWith('https://') ? origin : undefined);

/** The command that starts the downloaded runner package and allows one website origin to pair with it. */
export const runnerCommand = (origin?: string) => `npm exec --yes --package ./${TARBALL} -- passkey-recovery${origin ? ` --allow-origin ${origin}` : ''}`;
