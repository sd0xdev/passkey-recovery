// Where this build comes from and where its runner package will be published. The version is read from package.json at
// build time (Vite inlines only the `version` field). The source repository is public (REPO_URL). The release URLs exist
// only once the maintainer publishes the GitHub Release for this tag; until then the page offers a build from a clone of
// that source (docs/release/release-plan.md).
import { version } from '../../package.json';

export const VERSION: string = version;
export const REPO_URL = 'https://github.com/sd0xdev/passkey-recovery';
/** Voluntary one-time support, the same page as .github/FUNDING.yml. Never add a query: no address or tracking. */
export const SPONSOR_URL = 'https://buy.stripe.com/8x2eVdfSh6KZ4mf6wm0sU06';
export const CLONE_COMMANDS = ['git clone https://github.com/sd0xdev/passkey-recovery.git', 'cd passkey-recovery'].join('\n');
export const RELEASE_TAG = `v${VERSION}`;
export const TARBALL = `passkey-recovery-${VERSION}.tgz`;
export const RELEASE_PAGE_URL = `${REPO_URL}/releases/tag/${RELEASE_TAG}`;
export const TARBALL_URL = `${REPO_URL}/releases/download/${RELEASE_TAG}/${TARBALL}`;

/** The runner pairs only with exact https origins: an http page (a local preview) is never offered as one. */
export const pairableOrigin = (origin: string): string | undefined => (origin.startsWith('https://') ? origin : undefined);

/** The command that starts the runner from a built clone of the source and allows one website origin to pair with it. */
export const sourceRunnerCommand = (origin?: string) => `npm run runner${origin ? ` -- --allow-origin ${origin}` : ''}`;

/** The same, from a package file the reader packed from that clone. */
export const runnerCommand = (origin?: string) => `npm exec --yes --package ./${TARBALL} -- passkey-recovery${origin ? ` --allow-origin ${origin}` : ''}`;
