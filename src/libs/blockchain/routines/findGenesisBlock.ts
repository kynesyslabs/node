/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as fs from "fs"
import log from "@/utilities/logger"
import Chain from "src/libs/blockchain/chain"
import { BeforeFindGenesisHooks } from "./beforeFindGenesisHooks"
import { Config } from "src/config"
import { getSharedState } from "@/utilities/sharedState"
import { ForkConfigValidationError, loadForkConfigFromGenesis } from "@/forks"
import { isForkMachineryDisabled } from "@/forks/loadForkConfig"
import {
    GenesisRefusal,
    freshGenesisProblems,
    parseGenesisPin,
    parseStoredGenesisData,
    pinRequirementProblem,
    restartGenesisProblems,
} from "@/libs/blockchain/genesis/genesisPin"
import {
    acceptSchedule,
    parseOverrideDigest,
    scheduleDigest,
    scheduleFromForkConfig,
} from "@/libs/blockchain/genesis/acceptedForkSchedule"
import {
    readAcceptedSchedule,
    writeAcceptedSchedule,
} from "@/libs/blockchain/genesis/acceptedForkScheduleStore"
import { snapshotManifestHash } from "@/libs/blockchain/genesis/loadSnapshot"
import type { ForkConfigLike } from "@/libs/peer/routines/forkScheduleAgreement"
import { WINDOW_BLOCKS } from "@/libs/peer/routines/forkScheduleWatch"
import {
    loadShardSizeFromGenesisBlock,
    readGenesisShardSize,
} from "@/libs/consensus/genesisShardSize"

function getLatestGCRRecoveryData() {
    if (!Config.getInstance().core.restore) {
        return null
    }

    const path = "output/"

    // return the file with the latest timestamp
    try {
        const files = fs.readdirSync(path)
        const latestFile = files.sort((a, b) => {
            const timeA = fs.statSync(path + a).mtime.getTime()
            const timeB = fs.statSync(path + b).mtime.getTime()
            return timeB - timeA
        })[0]

        return JSON.parse(fs.readFileSync(path + latestFile, "utf8"))
    } catch (error) {
        return null
    }
}

function readGenesisFile() {
    let genesisData = JSON.parse(fs.readFileSync("data/genesis.json", "utf8"))
    if (typeof genesisData === "string") {
        genesisData = JSON.parse(genesisData)
    }
    return genesisData
}

/**
 * Fail closed on ANY failure to read the fork config: a malformed
 * activationHeight, a JSON parse error or an IO read error are all operator
 * misconfigurations of consensus-relevant state.
 * The caller only gets here when the file exists, so everything inside is a
 * real read or validation failure. A silent fallback would let a typo or a
 * truncated file disable the fork on this validator while peers cross the
 * activation height, the same consensus split the validation throw prevents.
 */
function loadForkConfigFromGenesisFile() {
    try {
        loadForkConfigFromGenesis(readGenesisFile())
    } catch (e) {
        if (e instanceof ForkConfigValidationError) {
            log.error(
                `[FORKS] Refusing to boot — invalid fork config in data/genesis.json: ${e.message}`,
            )
            throw e
        }
        log.error(
            `[FORKS] Refusing to boot — failed to read fork config from data/genesis.json: ${
                e instanceof Error ? e.message : String(e)
            }`,
        )
        throw e
    }
}

/** Overlay a recovery export's users and genesis balances onto the genesis data. */
function applyRecoveryData(genesisData, recoveryGenesis) {
    const finalBalances = {}

    for (const entry of genesisData["balances"]) {
        const [address, balance] = entry
        finalBalances[address] = balance
    }

    genesisData["users"] = recoveryGenesis["users"]

    // add recoveryGenesis["genesis_balances"] to genesisData["balances"]
    // (replacing the ones that are already in genesisData["balances"])
    for (const entry of recoveryGenesis["genesis_balances"]) {
        const [address, balance] = entry
        finalBalances[address] = balance
    }

    genesisData["balances"] = Object.entries(finalBalances)
}

export default async function findGenesisBlock() {
    // INFO: Maintenance hooks here!
    // await new BeforeFindGenesisHooks().awardDemosFollowPoints()

    // REVIEW: P2 — load fork config from data/genesis.json (when present)
    // BEFORE the genesis-already-present early return, so a node that has
    // already initialized its chain still picks up its fork activation
    // heights at every boot. Absent `forks` field leaves
    // SharedState.forkConfig at its inactive default, matching pre-P2
    // behavior bit-for-bit.
    const hasGenesisFile = fs.existsSync("data/genesis.json")
    if (hasGenesisFile) {
        loadForkConfigFromGenesisFile()
    } else {
        // With no genesis file there is nothing to load: the defaults are this
        // node's schedule, and it can report them.
        getSharedState.forkConfigLoaded = true
    }

    const pin = parseGenesisPin(Config.getInstance().core.expectedGenesisHash)
    const pinProblem = pinRequirementProblem(pin, process.env)
    if (pinProblem) refuse([pinProblem])

    log.info("[GENESIS] Looking for the genesis block...")
    const genesisBlockHash = await Chain.getGenesisBlockHash()
    if (genesisBlockHash) {
        log.info(`[GENESIS] Genesis block found. Hash: ${genesisBlockHash}`)
        const genesisContent = (await Chain.getGenesisBlock())?.content as
            | { extra?: { genesisData?: unknown } }
            | undefined
        const stored = parseStoredGenesisData(genesisContent?.extra?.genesisData)
        refuse(
            restartGenesisProblems({
                storedGenesisData: stored,
                // Without a file only the pin can be checked; the schedule check
                // below still sees the defaults this node would run with.
                fileGenesisData: hasGenesisFile ? readGenesisFile() : stored,
                pin,
            }),
        )
        await acceptLoadedForkSchedule(await Chain.getLastBlockNumber())
        await loadShardSizeFromGenesisBlock()
        return
    }

    if (!hasGenesisFile) {
        log.error("[GENESIS] No genesis block found, aborting boot")
        // Audit-sweep batch E: was `process.exit(1)`. Throw so
        // `main().catch → gracefulShutdown` handles uniformly.
        throw new Error(
            "[GENESIS] data/genesis.json missing — refusing to boot",
        )
    }

    // Loading the genesis block
    const genesisData = readGenesisFile()

    // Everything is checked before the first write: a refused node must leave
    // an empty database, or its next boot finds a block 0 and trusts it.
    refuse(
        freshGenesisProblems({
            genesisData,
            pin,
            restore: Config.getInstance().core.restore,
            snapshotManifestHash: await snapshotManifestHash(),
        }),
    )
    if (pin !== "") {
        log.info(`[GENESIS] data/genesis.json matches EXPECTED_GENESIS_HASH ${pin}`)
    }

    const recoveryGenesis = getLatestGCRRecoveryData()
    if (recoveryGenesis) {
        applyRecoveryData(genesisData, recoveryGenesis)
    }

    // Fail before block 0 is generated: a genesis without a valid shard
    // size would be committed, hashed, and impossible to fix in place.
    readGenesisShardSize(genesisData)

    // Adding the genesis block to the chain
    const genesisBlock = await Chain.generateGenesisBlock(genesisData)
    getSharedState.genesisCreatedThisBoot = true
    // Block 0 was just created from this schedule; a row left by an earlier
    // chain in a partly wiped database says nothing about this one.
    await writeAcceptedSchedule(currentSchedule(), 0)
    await loadShardSizeFromGenesisBlock()
    return genesisBlock
}

function currentSchedule() {
    return scheduleFromForkConfig(
        getSharedState.forkConfig as unknown as ForkConfigLike,
        getSharedState.chainId,
    )
}

function refuse(problems: string[]): void {
    if (problems.length === 0) return
    for (const problem of problems) {
        log.error(`[GENESIS] Refusing to boot: ${problem}`)
    }
    throw new GenesisRefusal(`[GENESIS] Refusing to boot: ${problems.join("; ")}`)
}

/**
 * Compare the schedule just loaded from the genesis file with the one this
 * node last ran with, and store it when the change is allowed.
 */
async function acceptLoadedForkSchedule(tip: number): Promise<void> {
    if (isForkMachineryDisabled()) return
    const current = currentSchedule()
    const accepted = await readAcceptedSchedule()
    if (accepted === null) {
        await writeAcceptedSchedule(current, tip)
        log.info(
            `[FORKS] Accepted fork schedule ${scheduleDigest(current)} at tip ${tip}`,
        )
        return
    }
    const verdict = acceptSchedule(
        accepted,
        current,
        tip,
        WINDOW_BLOCKS,
        parseOverrideDigest(process.env.DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST),
    )
    if (verdict.status === "unchanged") return
    if (verdict.status === "refused") {
        refuse([
            `fork schedule in data/genesis.json differs from the one this node ran with: ` +
                verdict.problems.join("; ") +
                `. If every operator agreed to this exact schedule, restart with ` +
                `DEMOS_ACCEPT_FORK_SCHEDULE_DIGEST=${verdict.digest}`,
        ])
        return
    }
    for (const change of verdict.changes) {
        log.warning(`[FORKS] Fork schedule change accepted at tip ${tip}: ${change}`)
    }
    await writeAcceptedSchedule(current, tip)
}
