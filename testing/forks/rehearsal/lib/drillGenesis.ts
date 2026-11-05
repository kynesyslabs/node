/**
 * Drill genesis staging: a rehearsal genesis whose validator set is the
 * devnet nodes' own keys.
 *
 * `generate-identities.sh` mints fresh keys on every run, so a genesis with
 * fixed addresses names validators that are not running. Under
 * committeeBinding the committee comes from chain data alone, so such a
 * chain has no live committee member and never leaves block 0.
 * `testing/devnet/scripts/generate-genesis.sh` does this for
 * `genesis.devnet.json`; the drill needs the same for `data/genesis.json`.
 */

import { existsSync, readFileSync } from "fs"
import { resolve } from "path"
import { DEVNET_DIR } from "./devnetControl"

/** `NODE<i>_PORT` defaults of `generate-genesis.sh` and docker-compose.yml. */
export const DEFAULT_NODE_PORTS: Record<number, string> = {
    1: "53551",
    2: "53553",
    3: "53555",
    4: "53557",
    5: "53559",
}
/** `DEVNET_VALIDATOR_STAKE` default of `generate-genesis.sh`. */
export const DEFAULT_VALIDATOR_STAKE = "1000000000000000000"

/** The address shape the node accepts for a genesis validator. */
const ADDRESS_RE = /^0x[0-9a-fA-F]{64}$/

type Genesis = Record<string, any>

/**
 * Copy of `genesis` whose `validators` are `pubkeys` in order, each funded
 * with `stake` in `balances`. Node `i + 1` gets `ports[i]` as its URL, the
 * entry shape `generate-genesis.sh` writes. Balances of other accounts are
 * kept; an existing balance of a validator is replaced. Everything else
 * (properties, forks, mutables) is left as it is.
 */
export function withDevnetValidators(
    genesis: Genesis,
    pubkeys: string[],
    ports: string[],
    stake: string,
): Genesis {
    if (pubkeys.length === 0) throw new Error("no validator pubkeys given")
    if (ports.length !== pubkeys.length) {
        throw new Error(`${ports.length} ports for ${pubkeys.length} pubkeys`)
    }
    for (const pubkey of pubkeys) {
        if (!ADDRESS_RE.test(pubkey)) {
            throw new Error(`validator pubkey must be 0x + 64 hex chars, got "${pubkey}"`)
        }
    }
    const lower = pubkeys.map(p => p.toLowerCase())
    if (new Set(lower).size !== lower.length) {
        throw new Error("duplicate validator pubkeys")
    }

    const validators = pubkeys.map((address, i) => ({
        address,
        status: "2",
        connection_url: `http://node-${i + 1}:${ports[i]}`,
        staked_amount: stake,
        first_seen: 0,
        valid_at: 0,
    }))
    const funded = new Set(lower)
    const kept = ((genesis.balances ?? []) as unknown[]).filter(
        pair =>
            Array.isArray(pair) &&
            pair.length === 2 &&
            !funded.has(String(pair[0]).toLowerCase()),
    )
    return {
        ...genesis,
        validators,
        balances: [...pubkeys.map(address => [address, stake]), ...kept],
    }
}

/** `KEY=VALUE` lines of the devnet `.env`, which docker-compose reads too. */
function readDevnetEnvFile(): Record<string, string> {
    const path = resolve(DEVNET_DIR, ".env")
    if (!existsSync(path)) return {}
    const env: Record<string, string> = {}
    for (const line of readFileSync(path, "utf8").split("\n")) {
        const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
        if (m) env[m[1]] = m[2].replace(/^(["'])(.*)\1$/, "$2")
    }
    return env
}

/**
 * Reads `testing/devnet/identities/node{1..count}.pubkey`. Call it after
 * `regenerateIdentities`: the files change on every run.
 */
export function readDevnetPubkeys(count: number): string[] {
    const pubkeys: string[] = []
    for (let i = 1; i <= count; i++) {
        const path = resolve(DEVNET_DIR, "identities", `node${i}.pubkey`)
        if (!existsSync(path)) {
            throw new Error(`missing identity for node${i} (${path}); run regenerateIdentities first`)
        }
        pubkeys.push(readFileSync(path, "utf8").trim())
    }
    return pubkeys
}

/** Drill genesis with the validators of the devnet's current identities. */
export function withCurrentDevnetValidators(genesis: Genesis, count: number): Genesis {
    const fileEnv = readDevnetEnvFile()
    const setting = (name: string): string | undefined => process.env[name] || fileEnv[name] || undefined
    const ports = Array.from({ length: count }, (_, i) => {
        const port = setting(`NODE${i + 1}_PORT`) ?? DEFAULT_NODE_PORTS[i + 1]
        if (port === undefined) throw new Error(`no port known for node ${i + 1}`)
        return port
    })
    return withDevnetValidators(
        genesis,
        readDevnetPubkeys(count),
        ports,
        setting("DEVNET_VALIDATOR_STAKE") ?? DEFAULT_VALIDATOR_STAKE,
    )
}
