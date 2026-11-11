/**
 * Call a sudo-only RPC method (rate-limit/unblock, getCampaignData,
 * awardPoints) as the genesis sudo key.
 *
 *   SUDO_MNEMONIC="..." bun scripts/sudo-call.ts --rpc URL --method NAME [--params JSON]
 *   bun scripts/sudo-call.ts --rpc URL --method NAME --mnemonic-file FILE [--params JSON]
 *
 * Nodes take these methods only in the body-bound auth form, which signs
 * the exact body, the timestamp, the network's genesis hash and the public
 * key of the node called, so the call is refused by every other node; SDK
 * `demos.call` sends the older form and is refused with 401. Call each node
 * separately. A remote node needs https; SUDO_CALL_ALLOW_HTTP=1 allows plain
 * http to one, for a network path the operator trusts.
 *
 * Examples:
 *   --method rate-limit/unblock --params '["203.0.113.4"]'
 *   --method getCampaignData
 *   --method awardPoints --params '[{"message":[{"address":"0x…","points":10}]}]'
 */

import { readFileSync } from "node:fs"
import { Demos } from "@kynesyslabs/demosdk/websdk"
import { uint8ArrayToHex } from "@kynesyslabs/demosdk/encryption"
import {
    SUDO_METHODS,
    bodyBoundAuthHeaders,
    fetchGenesisHash,
    fetchNodePublicKey,
} from "src/libs/network/peerHttpAuth"

const USAGE =
    "usage: bun scripts/sudo-call.ts --rpc URL --method NAME [--params JSON] [--mnemonic-file FILE]"

function parseArgs(argv: string[]) {
    const args: Record<string, string> = {}
    for (let i = 0; i < argv.length; i += 2) {
        const flag = argv[i]
        if (!flag?.startsWith("--") || argv[i + 1] === undefined) throw new Error(USAGE)
        args[flag.slice(2)] = argv[i + 1]
    }
    if (!args.rpc || !args.method) throw new Error(USAGE)
    return args
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"])

/**
 * Why `rpcUrl` may not carry a sudo call, or null. Over plain http to
 * another host an observer reads the call and the answer, which for
 * getCampaignData is data only the sudo key may see.
 */
export function cleartextRefusal(rpcUrl: string, allowHttp: boolean): string | null {
    const url = new URL(rpcUrl)
    if (url.protocol === "https:" || allowHttp || LOCAL_HOSTS.has(url.hostname)) return null
    return `${rpcUrl} is plain http to a remote node: use https, or set SUDO_CALL_ALLOW_HTTP=1 for a trusted path`
}

async function main() {
    const args = parseArgs(process.argv.slice(2))
    if (!SUDO_METHODS.has(args.method)) {
        throw new Error(`${args.method} is not a sudo method (${[...SUDO_METHODS].join(", ")})`)
    }
    const refusal = cleartextRefusal(args.rpc, process.env.SUDO_CALL_ALLOW_HTTP === "1")
    if (refusal) throw new Error(refusal)
    const mnemonic = (
        args["mnemonic-file"] ? readFileSync(args["mnemonic-file"], "utf8") : process.env.SUDO_MNEMONIC ?? ""
    ).trim()
    if (!mnemonic) throw new Error("set SUDO_MNEMONIC or pass --mnemonic-file")

    const demos = new Demos()
    await demos.connect(args.rpc)
    await demos.connectWallet(mnemonic, { algorithm: "ed25519" })
    const { publicKey } = await demos.crypto.getIdentity("ed25519")

    const body = JSON.stringify({ method: args.method, params: JSON.parse(args.params ?? "[]") })
    const headers = await bodyBoundAuthHeaders({
        genesisHash: await fetchGenesisHash(args.rpc),
        audience: await fetchNodePublicKey(args.rpc),
        identity: `ed25519:${uint8ArrayToHex(publicKey as Uint8Array)}`,
        body,
        sign: async message => (await demos.crypto.sign("ed25519", message)).signature as Uint8Array,
    })

    const res = await fetch(args.rpc, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body,
    })
    console.log(JSON.stringify(await res.json().catch(() => ({ status: res.status })), null, 2))
    if (!res.ok) process.exit(1)
}

if (import.meta.main) {
    try {
        await main()
    } catch (error) {
        console.error(error instanceof Error ? error.message : error)
        process.exit(2)
    }
}
