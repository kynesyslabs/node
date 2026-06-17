#!/usr/bin/env bun
/**
 * Create a fresh L2PS subnet locally — generates an AES-256 key + IV,
 * writes the `config.json` / `private_key.txt` / `iv.txt` triple under
 * `data/l2ps/<UID>/`, and prints the resulting layout.
 *
 * A subnet is just three files on disk; the node loads them at boot
 * via `loadSnapshot` / `parallelNetworks.getL2PS`. There is no on-chain
 * registration step.
 *
 * Usage:
 *   bun scripts/l2ps-create-subnet.ts --uid <UID> [--rpc <url>] [--out <dir>] [--force]
 *
 * Example:
 *   bun scripts/l2ps-create-subnet.ts --uid testnet_l2ps_001 \
 *       --rpc https://node2.demos.sh:53650 \
 *       --rpc https://node3.demos.sh:53650
 *
 * After creation, deploy to a remote node with:
 *   ./scripts/l2ps-install-subnet.sh --uid <UID> --hosts node2.demos.sh,node3.demos.sh
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { randomBytes } from "node:crypto"
import path from "node:path"

interface CliOptions {
    uid: string
    rpcs: string[]
    outDir: string | null
    force: boolean
}

function parseArgs(argv: string[]): CliOptions {
    const opts: CliOptions = {
        uid: "",
        rpcs: [],
        outDir: null,
        force: false,
    }
    const consume = (i: number, flag: string): string => {
        const v = argv[i + 1]
        if (!v || v.startsWith("--")) {
            throw new Error(`${flag} requires a value`)
        }
        return v
    }
    for (let i = 2; i < argv.length; i++) {
        const a = argv[i]
        switch (a) {
            case "--uid":
                opts.uid = consume(i, a)
                i++
                break
            case "--rpc":
                opts.rpcs.push(consume(i, a))
                i++
                break
            case "--out":
                opts.outDir = consume(i, a)
                i++
                break
            case "--force":
                opts.force = true
                break
            case "--help":
            case "-h":
                printHelp()
                process.exit(0)
                break
            default:
                throw new Error(`unknown flag: ${a}`)
        }
    }
    if (!opts.uid) throw new Error("--uid is required")
    if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(opts.uid)) {
        throw new Error(
            `--uid must be 1-64 chars of [a-zA-Z0-9_.-], got ${JSON.stringify(opts.uid)}`,
        )
    }
    return opts
}

function printHelp(): void {
    console.log(`Usage: bun scripts/l2ps-create-subnet.ts --uid <UID> [options]

Required:
  --uid <UID>       Subnet identifier (1-64 chars of [a-zA-Z0-9_.-])

Optional:
  --rpc <url>       Add an RPC URL to known_rpcs. Repeat for multiple.
                    Defaults to ["http://127.0.0.1:53550"] if none given.
  --out <dir>       Output directory (default: data/l2ps/<UID>)
  --force           Overwrite an existing subnet directory.
  --help, -h        Show this help.

The script generates a 32-byte AES key and a 16-byte IV, writes them
hex-encoded to private_key.txt / iv.txt, and emits a config.json with
relative paths the node expects.

After local creation, deploy to remote nodes:
  ./scripts/l2ps-install-subnet.sh --uid <UID> --hosts host1,host2

Security note: every file under the subnet directory is a long-lived
secret. Do not commit to git, do not paste in chat, do not deploy to
shared hosts unless that subnet is dev-only.`)
}

function main(): void {
    const opts = parseArgs(process.argv)
    const repoRoot = path.resolve(import.meta.dirname, "..")
    const dir = opts.outDir
        ? path.resolve(opts.outDir)
        : path.join(repoRoot, "data", "l2ps", opts.uid)

    if (existsSync(dir) && !opts.force) {
        console.error(
            `error: ${dir} already exists. Pass --force to overwrite (this destroys the existing keys).`,
        )
        process.exit(2)
    }
    mkdirSync(dir, { recursive: true })

    // 32 bytes = AES-256; 16 bytes = AES block size. Hex-encoded
    // matches the format the existing fixtures use (testnet_l2ps_001,
    // acd_demo_001) so the node's loader parses them with no shape change.
    const keyHex = randomBytes(32).toString("hex")
    const ivHex = randomBytes(16).toString("hex")

    const keyPath = path.join(dir, "private_key.txt")
    const ivPath = path.join(dir, "iv.txt")
    const configPath = path.join(dir, "config.json")

    writeFileSync(keyPath, keyHex + "\n", { mode: 0o600 })
    writeFileSync(ivPath, ivHex + "\n", { mode: 0o600 })

    const relKeyPath = path.posix.join("data/l2ps", opts.uid, "private_key.txt")
    const relIvPath = path.posix.join("data/l2ps", opts.uid, "iv.txt")
    const config = {
        uid: opts.uid,
        enabled: true,
        config: {
            created_at_block: 0,
            known_rpcs: opts.rpcs.length > 0 ? opts.rpcs : ["http://127.0.0.1:53550"],
        },
        keys: {
            private_key_path: relKeyPath,
            iv_path: relIvPath,
        },
    }
    writeFileSync(configPath, JSON.stringify(config, null, 4) + "\n")

    console.log(`Created L2PS subnet "${opts.uid}" at:`)
    console.log(`  ${configPath}`)
    console.log(`  ${keyPath}   (32-byte AES-256 key, hex)`)
    console.log(`  ${ivPath}    (16-byte IV, hex)`)
    console.log()
    console.log("Next step — deploy to remote nodes that should process txs")
    console.log(`for this UID:`)
    console.log()
    console.log(
        `  ./scripts/l2ps-install-subnet.sh --uid ${opts.uid} --hosts <host1>,<host2>`,
    )
}

try {
    main()
} catch (e) {
    console.error(`error: ${(e as Error).message}`)
    process.exit(1)
}
