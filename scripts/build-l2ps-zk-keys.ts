/**
 * Builds the L2PS batch proving keys into src/libs/l2ps/zk/keys, for the
 * release image. Uses the setup wizard's own build, so the result must match
 * the committed verification keys or the build fails.
 *
 * Usage: bun scripts/build-l2ps-zk-keys.ts [ptau base url ...]
 */
import { runL2psZkSetup, PTAU_BASE_URLS } from "../src/cli/setup/zk"
import { createDefaultRunner } from "../src/cli/setup/runner"

const root = process.cwd()
const mirrors = process.argv.length > 2 ? process.argv.slice(2) : PTAU_BASE_URLS

const result = await runL2psZkSetup(root, createDefaultRunner(), line => console.log(line), undefined, mirrors)
for (const m of result.messages) console.log(m)
process.exit(result.ok ? 0 : 1)
