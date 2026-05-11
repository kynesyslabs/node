import { ValidationPhase, emptyValidationPhase } from "./validationStatusTypes"
import { Shard } from "./shardTypes"
import { getSharedState } from "src/utilities/sharedState"
import getShard from "../routines/getShard"
import _ from "lodash"
import { forgeToHex } from "src/libs/crypto/forgeUtils"
import { Waiter } from "src/utilities/waiter"
import { _required as required } from "@kynesyslabs/demosdk/websdk"
import { RPCRequest, RPCResponse } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import { TimeoutError, AbortError, NotInShardError } from "@/errors"
import getCommonValidatorSeed from "../routines/getCommonValidatorSeed"

export class AbortConsensusError extends Error {
    constructor(message: string) {
        super(message)
        this.name = "AbortConsensusError"
    }
}

// ANCHOR SecretaryManager
export default class SecretaryManager {
    private _greenlight_timeout = 60_000 // 60 seconds
    private _set_validator_phase_timeout = 30_000 // 30 seconds

    // A map of block numbers to SecretaryManager instances
    private static instances: Map<number, SecretaryManager> = new Map()
    static get lastBlockRef() {
        return (
            Array.from(SecretaryManager.instances.keys()).sort(
                (a, b) => b - a,
            )[0] || 0
        )
    }

    // Internal variables
    public shard: Shard
    public get secretary() {
        return this.shard.members[0]
    }

    public ourValidatorPhase: ValidationPhase
    public ourKey: string
    public runSecretaryRoutine = false
    public blockTimestamp: number = null

    constructor() {}

    /**
     * Initializes the shard, including the members and the validation phases.
     *
     * @param cVSA The CVSA string
     * @param lastBlockNumber The last block number
     * @returns The list of shard members
     */
    async initializeShard(cVSA: string, lastBlockNumber: number) {
        this.shard = {
            CVSA: cVSA,
            members: [],
            validationPhases: {},
            secretaryKey: "",
            blockRef: lastBlockNumber + 1,
        }

        // Reusing the method to create the members
        this.shard.members = await getShard(cVSA)
        // this.ourKey = getSharedState.identity.ed25519.publicKey.toString("hex")
        this.ourKey = getSharedState.publicKeyHex

        if (
            !this.shard.members.map(peer => peer.identity).includes(this.ourKey)
        ) {
            log.error("We are not in the shard")
            throw new NotInShardError("We are not in the shard")
        }
        // Assigning the secretary and its key
        this.shard.secretaryKey = this.secretary.identity

        log.debug("\n\n\n")
        log.debug("INITIALIZED SHARD:")
        log.debug(
            `SHARD: ${JSON.stringify(
                this.shard.members.map(m => m.connection.string),
            )}`,
        )
        log.debug(`SECRETARY: ${this.secretary.identity}`)

        // INFO: Start the secretary routine
        if (this.checkIfWeAreSecretary()) {
            log.debug(
                "⬜️ We are the secretary ⬜️. starting the secretary routine",
            )
            this.secretaryRoutine().finally(async () => {
                log.debug("Secretary routine finished confetti confetti 🎊🎉")
            })
        }

        // INFO: Initializing the validation phases
        return this.initializeValidationPhases()
    }

    /**
     * Initializes the validation phases for each member of the shard
     * to an empty validation phase, including the current node's. (this.ourValidatorPhase)
     *
     * @returns The list of shard members
     */
    public initializeValidationPhases() {
        for (const member of this.shard.members) {
            this.shard.validationPhases[member.identity] =
                _.cloneDeep(emptyValidationPhase)
        }

        this.ourValidatorPhase = _.cloneDeep(emptyValidationPhase)
        return this.shard.members
    }

    // SECTION Methods called by the Secretary only

    // REVIEW Base check to see if we are the secretary, called by all the methods that the Secretary can call
    public checkIfWeAreSecretary() {
        return this.shard.secretaryKey === getSharedState.publicKeyHex
    }

    /**
     * The secretary routine
     *
     * Sets up a while loop that will be continue when nodes submit their validator phase
     * or when the secretary times out.
     *
     * A timeout means that either:
     * - a node went offline
     * - a node is stuck in a past validator phase
     * - a node was unable to submit its validator phase due to a network issue.
     *
     * In the case of a timeout, the secretary will:
     * - try to ping offline nodes, and if they are offline, remove them from the shard
     * - release the waiting members
     *
     * The loop will restart, until we dispatch the readyToEndConsensus greenlight and end the consensus routine.
     */
    async secretaryRoutine() {
        required(
            this.checkIfWeAreSecretary(),
            "Only the Secretary can run this routine",
        )

        this.runSecretaryRoutine = true
        for (const member of this.shard.members) {
            const waiterId =
                member.identity + Waiter.keys.WAIT_FOR_SECRETARY_ROUTINE

            // INFO: If there are waiting nodes, waiting for the secretary routine, release them.
            // Their waiter is set on the handler for "setValidatorPhase" in manageConsensusRoutines.ts
            if (Waiter.isWaiting(waiterId)) {
                Waiter.resolve(waiterId)
            }
        }

        if (!this.blockTimestamp) {
            // INFO: If the block timestamp is not set, initialize it
            // INFO: This should only happen when starting the consensus
            // If we elect this node to be secretary, after the original secretary
            // went offline, it should already have the original secretary's block timestamp
            log.debug(
                "[SECRETARY ROUTINE] Initializing the block timestamp FOR THE FIRST TIME",
            )
            this.blockTimestamp = Math.floor(Date.now() / 1000)
            log.debug(
                `[SECRETARY ROUTINE] Block timestamp: ${this.blockTimestamp}`,
            )
        }

        while (this.runSecretaryRoutine) {
            try {
                if (Waiter.isWaiting(Waiter.keys.SET_WAIT_STATUS)) {
                    log.debug(
                        "[SECRETARY ROUTINE] Existing SET_WAIT_STATUS waiter found. Waiting for that one ...",
                    )
                    await Waiter.waitList.get(Waiter.keys.SET_WAIT_STATUS)
                        .promise
                } else {
                    log.debug(
                        "[SECRETARY ROUTINE] Waiting for the set wait status",
                    )
                    await Waiter.wait(
                        Waiter.keys.SET_WAIT_STATUS,
                        this._set_validator_phase_timeout,
                    )
                    log.debug(
                        "[SECRETARY ROUTINE] SET_WAIT_STATUS Lock resolved",
                    )
                }
            } catch (error) {
                log.error(
                    "[SECRETARY ROUTINE] Error waiting for SET_WAIT_STATUS:",
                )

                log.error(error as string)

                if (error instanceof TimeoutError) {
                    // INFO: If the secretary routine times out, we need to handle the nodes that are gone offline
                    // Then release the waiting members
                    // NOTE: To give time for the secretary to check for offline nodes,
                    // we need to give SET_WAIT_STATUS less time than the GREEN_LIGHT waiter
                    // TODO: Adjust the timeouts and test them.

                    log.error(
                        "[SECRETARY ROUTINE] Timeout waiting for SET_WAIT_STATUS",
                    )
                    const waitingMembers = this.getWaitingMembers()
                    const stillOnlineMembers =
                        await this.handleNodesGoneOffline(waitingMembers)

                    const allOnlineMembers =
                        waitingMembers.concat(stillOnlineMembers)
                    // NOTE: We don't await this. We just trigger it and continue the routine
                    log.debug(
                        "[SECRETARY ROUTINE] Releasing the waiting members",
                    )
                    this.releaseWaitingMembers(
                        allOnlineMembers,
                        null,
                        "secretaryRoutine_TIMEOUT",
                    )
                }

                if (error instanceof AbortError) {
                    log.warn(
                        "[SECRETARY ROUTINE] AbortError for SET_WAIT_STATUS caught, exiting the secretary routine",
                    )

                    return
                }
            }
        }
    }

    /**
     * Handles the nodes that are gone offline
     *
     * INFO: Receives a list of known waiting members
     * We filter the shard members to get the ones that are not in the waiting list
     * We then ping them to check if they are still online
     * If they are not, we remove them from the shard
     * @param waitingMembers The list of known waiting members
     */
    public async handleNodesGoneOffline(waitingMembers: string[]) {
        log.debug("[SECRETARY ROUTINE] Handling nodes gone offline")
        const maybeOfflineMembers = this.shard.members.filter(
            m => !waitingMembers.includes(m.identity),
        )
        log.debug(
            `Maybe offline members: ${maybeOfflineMembers.map(m => m.identity)}`,
        )

        const promises = maybeOfflineMembers.map(member => member.connect())
        const results = await Promise.all(promises)

        const onlineMembers: string[] = []
        for (const [index, isOnline] of results.entries()) {
            const member = maybeOfflineMembers[index]

            if (isOnline) {
                onlineMembers.push(member.identity)
                log.debug(
                    `[SECRETARY ROUTINE] ${member.identity} is still online, will still receive the green light`,
                )
            } else {
                log.debug(
                    `[SECRETARY ROUTINE] ${member.identity} is offline, removing from the shard`,
                )

                this.shard.members = this.shard.members.filter(
                    m => m.identity !== member.identity,
                )
                delete this.shard.validationPhases[member.identity]
            }
        }

        return onlineMembers
    }

    /**
     * Handles the secretary going offline
     *
     * Ping the secretary to check if it's still online
     * If it's not, we elect the second node as the new secretary
     */
    public async handleSecretaryGoneOffline() {
        log.debug("[SECRETARY ROUTINE] Handling secretary going offline")
        if (!this.secretary) {
            log.error(
                "[Consensus] Secretary not found, exiting consensus routine",
            )
            throw new AbortConsensusError(
                "Secretary not found, exiting consensus routine",
            )
        }

        const isOnline = await this.secretary.connect()
        log.debug(`Secretary is online: ${isOnline}`)

        if (isOnline) {
            // REVIEW: Is that it?
            log.debug("Secretary is online, nothing to do")
            return
        }

        // INFO: ping for false negatives
        const isStillOnline = await this.secretary.connect()
        if (isStillOnline) {
            log.debug("Secretary is still online, nothing to do")
            return
        }

        log.debug(
            "Secretary is offline, electing the second node as the new secretary",
        )

        const exSecretary = this.secretary.identity
        this.shard.secretaryKey = this.shard.members[1].identity
        // remove secretary from the list of members
        this.shard.members = this.shard.members.filter(
            m => m.identity !== exSecretary,
        )
        delete this.shard.validationPhases[exSecretary]

        if (this.checkIfWeAreSecretary()) {
            // Start the secretary routine
            this.runSecretaryRoutine = true
            this.secretaryRoutine()

            const request: RPCRequest = {
                method: "consensus_routine",
                params: [
                    {
                        method: "getValidatorPhase",
                    },
                ],
            }

            const memberCalls = this.shard.members.map(member =>
                member
                    .call(request)
                    .then(res => ({ member, res }))
                    .catch(error => ({ member, error })),
            )

            const results = await Promise.all(memberCalls)

            for (const result of results) {
                if ("error" in result) {
                    log.error(
                        `[SECRETARY ROUTINE] Error getting the validator phase from ${result.member.identity}:`,
                        result.error,
                    )
                    continue
                }

                const { member, res } = result
                if (res.result !== 200) {
                    log.error(
                        `[SECRETARY ROUTINE] Error getting the validator phase from ${member.identity}: ${res.result}`,
                    )
                    continue
                }

                const phase = res.response[0] as number
                this.receiveValidatorPhase(member.identity, phase)
            }
        }

        // else {
        //     // TODO: Handle the case where the secretary is offline and we are not the second node
        //     // Send the validator phase to the new secretary

        //     log.debug("We are not the second node. Panicking ...")
        //     process.exit(0)
        // }
    }

    /**
     * Simulates the secretary going offline.
     * If we're forging block x = 5, kill the node if it's the secretary
     */
    public async simulateSecretaryGoingOffline() {
        const weAreForgingBlock = this.shard.blockRef === 10
        const weAreSecretary = this.checkIfWeAreSecretary()

        if (weAreForgingBlock && weAreSecretary) {
            log.debug("We are forging block and we are the secretary")
            log.debug("Killing the node using process.exit(0)...")
            process.exit(0)
        }
    }

    /**
     * Simulates a normal node going offline.
     *
     * If we're forging block x = 5, kill normal this node if it's not the secretary
     */
    public async simulateNormalNodeGoingOffline() {
        const weAreForgingBlock10 = this.shard.blockRef === 5
        const weAreNotTheSecretary = !this.checkIfWeAreSecretary()

        if (weAreForgingBlock10 && weAreNotTheSecretary) {
            log.debug("We are forging block #10 and we are not the secretary")
            log.debug("Killing the node using process.exit(0)...")
            process.exit(0)
        }
    }

    public async simulateNodeBeingLate() {
        // TODO: Delay sending of the validator phase to the secretary
        // and see what happens. Then handle it.
        return
    }

    public async receiveValidatorPhase(memberKey: string, theirPhase: number) {
        log.debug(`OUR PHASE: ${this.ourValidatorPhase.currentPhase}`)
        log.debug(`RECEIVED PHASE: ${theirPhase}`)

        const res = {
            greenlight: false,
        }

        if (!this.shard.validationPhases[memberKey]) {
            // INFO: This happens when a node enters an ongoing consensus
            log.debug(
                "New member trying to enter an ongoing consensus. Doing nothing ...",
            )
            return res
        }

        this.shard.validationPhases[memberKey].currentPhase = theirPhase
        this.shard.validationPhases[memberKey].phases[theirPhase][1] = true
        this.shard.validationPhases[memberKey].waitStatus = true

        if (!this.checkIfWeAreSecretary()) {
            log.debug(
                "[receiveValidatorPhase] ⚠️ A non-secretary node is calling this method!",
            )
            log.debug(`Member key: ${memberKey}`)
            log.debug(`Their phase: ${theirPhase}`)
            log.debug(`Our phase: ${this.ourValidatorPhase.currentPhase}`)
            log.debug(
                `SHARD MEMBERS: ${JSON.stringify(
                    this.shard.members.map(m => m.identity),
                    null,
                    2,
                )}`,
            )

            // INFO: Only the secretary should receive this function call!
            // INFO: We should never get in here!
            return res
        }

        // INFO: Check if node is behind us
        if (theirPhase < this.ourValidatorPhase.currentPhase) {
            log.debug(
                `[SECRETARY ROUTINE] Releasing ${memberKey} as they are behind us`,
            )
            this.releaseWaitingMembers(
                [memberKey],
                theirPhase,
                "receiveValidatorPhase",
            )

            res.greenlight = true
            return res
        }

        return {
            greenlight: await this.releaseWaitingRoutine(true),
        }
    }

    /**
     * A routine that releases waiting members if it's time to do so
     */
    public async releaseWaitingRoutine(resolveWaiter = false) {
        const shouldRelease = this.shouldReleaseWaitingMembers()
        log.debug(
            `[SECRETARY ROUTINE] Should release the waiting members? ${shouldRelease}`,
        )

        // INFO: Check if that peer was the one holding the green light
        if (shouldRelease) {
            // INFO: If we are in the last phase, stop the secretary routine
            if (this.ourValidatorPhase.currentPhase === 7) {
                this.runSecretaryRoutine = false
            }

            if (resolveWaiter) {
                // INFO: Release the waiting members
                Waiter.resolve(Waiter.keys.SET_WAIT_STATUS)
            }

            this.releaseWaitingMembers([], null, "releaseWaitingRoutine")
            log.debug("[SECRETARY ROUTINE] Released the waiting members")
            return true
        }

        return false
    }

    /**
     * Checks if we can release the waiting members. Checks if all the members are in the same phase as our local node and are waiting for the green light.
     *
     * @returns true if we can release the waiting members, false otherwise
     */
    public shouldReleaseWaitingMembers() {
        const ourPhase = this.ourValidatorPhase.currentPhase

        for (const [pubKey, phase] of Object.entries(
            this.shard.validationPhases,
        )) {
            if (phase.currentPhase !== ourPhase || !phase.waitStatus) {
                return false
            }
        }

        return true
    }

    /**
     * Sends a greenlight to the waiting members. Pass a list of public keys to release specific members.
     *
     * @param waitingMembers The list of members to release
     */
    public async releaseWaitingMembers(
        waitingMembers: string[] = [],
        phase?: number,
        src?: string,
    ) {
        required(this.checkIfWeAreSecretary(), "We are not the secretary")
        log.debug(`RELEASING WAITING MEMBERS FROM: ${src}`)

        if (!phase) {
            phase = this.ourValidatorPhase.currentPhase
        }

        // INFO: Release the waiting members
        // When members are provided, skip check
        if (waitingMembers.length === 0) {
            waitingMembers = this.getWaitingMembers()
        }

        log.debug(`WAITING MEMBERS: ${JSON.stringify(waitingMembers)}`)
        const promises = []

        for (const pubKey of waitingMembers) {
            const request: RPCRequest = {
                method: "consensus_routine",
                params: [
                    {
                        method: "greenlight",
                        params: [
                            this.shard.blockRef,
                            this.blockTimestamp,
                            phase,
                        ],
                    },
                ],
            }

            // INFO: Update the wait status of the member to false
            this.shard.validationPhases[pubKey].waitStatus = false
            const member = this.shard.members.find(m => m.identity === pubKey)

            log.debug(
                `[SECRETARY ROUTINE] Sending greenlight to ${member.identity}`,
            )

            log.debug(`Peer to receive greenlight: ${JSON.stringify(member)}`)
            log.debug(
                `[SECRETARY ROUTINE] Sending greenlight to ${member.identity} with timestamp ${this.blockTimestamp} and phase ${phase}`,
            )
            promises.push(
                member.longCall(request, true, {
                    sleepTime: 250,
                    retries: 4,
                    allowedCodes: [400],
                }),
            )
        }

        const results = await Promise.all(promises)

        for (const [index, result] of results.entries()) {
            const pubKey = waitingMembers[index]
            const member = this.shard.members.find(m => m.identity === pubKey)
            log.debug(`Peer who received greenlight: ${JSON.stringify(member)}`)

            if (result.result === 400) {
                log.debug(
                    "[SECRETARY ROUTINE] Received a 400: Consensus not reached",
                )
                log.debug(
                    "The node probably received the green light already via setValidatorPhase response",
                )
                continue
            }

            if (result.result === 200) {
                log.debug(`[SECRETARY ROUTINE] Greenlight sent to ${pubKey}`)
                log.debug(`Response: ${JSON.stringify(result)}`)
                continue
            }

            log.error(
                `[SECRETARY ROUTINE] Error sending greenlight to ${pubKey}`,
            )
            log.error(`Response: ${JSON.stringify(result)}`)
            process.exit(1)
        }

        return true
    }

    /**
     * Receives the green light from a validator. Called from the endpoint handler.
     *
     * @param secretaryBlockTimestamp The timestamp of the block proposed by the secretary
     * @param validatorPhase The phase number
     */
    public async receiveGreenLight(
        secretaryBlockTimestamp?: number,
        validatorPhase?: number,
    ) {
        if (!this.ourValidatorPhase) {
            log.debug("Our phase is undefined, doing nothing")
            return false
        }

        log.debug(`Received green light for phase: ${validatorPhase}`)
        log.debug("---- DIAGNOSTICS ----")
        log.debug(`Our phase: ${this.ourValidatorPhase.currentPhase}`)
        log.debug(`Our blockRef: ${this.shard.blockRef}`)
        log.debug(`Secretary timestamp: ${secretaryBlockTimestamp}`)
        log.debug(`Secretary: ${this.secretary.identity}`)
        log.debug("---- END DIAGNOSTICS ----")

        if (secretaryBlockTimestamp < this.blockTimestamp) {
            log.debug(
                "Greenlight received for an older block,returning false ...",
            )
            return false
        }

        // INFO: Only assign the block timestamp if it's greater than the current block timestamp
        // NOTE: Stray greenlights from previous rounds need to be ignored
        if (
            secretaryBlockTimestamp &&
            secretaryBlockTimestamp > this.blockTimestamp
        ) {
            this.blockTimestamp = secretaryBlockTimestamp
        }

        const waiterKey =
            Waiter.keys.GREEN_LIGHT + this.shard.blockRef + validatorPhase
        log.debug(`Waiter key: ${waiterKey}`)

        if (Waiter.isWaiting(waiterKey)) {
            Waiter.resolve(waiterKey, secretaryBlockTimestamp)
            this.ourValidatorPhase.waitStatus = false
            return true
        }

        if (this.ourValidatorPhase.currentPhase <= validatorPhase) {
            log.debug(`[SECRETARY ROUTINE] Pre-holding the key: ${waiterKey}`)
            log.debug(`Is Waiting for key: ${Waiter.isWaiting(waiterKey)}`)
            log.debug(
                `Waitlist keys: ${JSON.stringify(Array.from(Waiter.waitList.keys()))}`,
            )
            Waiter.preHold(waiterKey, secretaryBlockTimestamp)
            return true
        }

        if (this.ourValidatorPhase.currentPhase > validatorPhase) {
            // INFO: Older greenlight received, ignoring it
            return true
        }

        log.debug("We don't know what to do with this green light")
        log.debug(`Validator phase: ${validatorPhase}`)
        log.debug(`Our phase: ${this.ourValidatorPhase.currentPhase}`)
        log.debug(`Secretary block timestamp: ${secretaryBlockTimestamp}`)
        log.debug(`Block timestamp: ${this.blockTimestamp}`)
        process.exit(1)
    }

    /**
     * Gets the members that are waiting for the green light
     *
     * @returns The list of members that are waiting for the green light
     */
    public getWaitingMembers() {
        const ourPhase = this.ourValidatorPhase.currentPhase
        const waitingMembers: string[] = []

        for (const [pubKey, phase] of Object.entries(
            this.shard.validationPhases,
        )) {
            if (phase.currentPhase === ourPhase && phase.waitStatus) {
                waitingMembers.push(pubKey)
            }
        }

        return waitingMembers
    }

    /**
     * Sends our local validator phase to the secretary and waits for the green light
     * If resolved, returns the secretary block timestamp
     */
    public async sendOurValidatorPhaseToSecretary(retries = 3) {
        log.debug("Sending our validator phase to the secretary")
        log.debug(`Our phase: ${this.ourValidatorPhase.currentPhase}`)
        log.debug(`Shard block ref: ${this.shard.blockRef}`)

        const waiterKey =
            Waiter.keys.GREEN_LIGHT +
            this.shard.blockRef +
            this.ourValidatorPhase.currentPhase
        const greenlight: Promise<number | null> = Waiter.wait(
            waiterKey,
            this._greenlight_timeout,
        )

        log.debug("Greenlight waiter created")
        log.debug(`Waiter key: ${waiterKey}`)

        const sendStatus = async () => {
            const request: RPCRequest = {
                method: "consensus_routine",
                params: [
                    {
                        method: "setValidatorPhase",
                        params: [
                            this.ourValidatorPhase.currentPhase,
                            this.shard.CVSA,
                            this.shard.blockRef,
                        ],
                    },
                ],
            }

            if (!this.secretary) {
                // INFO: Node is running alone, and has kicked itself out of the shard
                return {
                    result: 500,
                    extra: {
                        greenlight: true,
                        timestamp: this.blockTimestamp,
                    },
                } as RPCResponse
            }

            log.debug("Sending setValidatorPhase request to the secretary")
            log.debug(`Secretary is: ${this.secretary.identity}`)
            return await this.secretary.longCall(request, true, {
                retries,
                sleepTime: 250,
                allowedCodes: [400],
            })
        }

        const handleSendStatusRes = async (res: RPCResponse) => {
            log.debug(
                `Our validator phase (${this.ourValidatorPhase.currentPhase}) sent to the secretary!`,
            )
            log.debug(`Set validator phase response: ${JSON.stringify(res)}`)

            if (!Waiter.isWaiting(waiterKey)) {
                // INFO: The secretary sent the green light for the phase before
                // the setValidatorPhase request returned.
                log.debug(
                    "[SEND OUR VALIDATOR PHASE] Key has already been resolved, doing nothing",
                )
                return null
            }

            if ([400, 500].includes(res.result)) {
                log.debug(
                    "[SEND OUR VALIDATOR PHASE] Error sending the setValidatorPhase request",
                )
                log.debug(`Response: ${JSON.stringify(res)}`)

                // REVIEW: How should we handle this?
                // NOTE: A 400 is returned if the block reference is
                // lower than the secretary's block reference
                // await this.handleSecretaryGoneOffline()
                // await sendStatus()

                // INFO: EXIT CONSENSUS ROUTINE
                Waiter.resolve<number>(waiterKey, "abortConsensus" as any)
            }

            log.debug(
                `[SEND OUR VALIDATOR PHASE] SendStatus callback got response: ${JSON.stringify(res)}`,
            )

            if (res.extra === 450) {
                log.debug("[SEND OUR VALIDATOR PHASE] Invalid seed detected")
                // process.exit(0)
                // INFO: Logs parts used to create the current CVSA
                await getCommonValidatorSeed(null, (message: string) => {
                    log.debug(message)
                })
                return null
            }

            // INFO: Extract the greenlight status and resolve the waiter
            const greenlight = Boolean(res.extra.greenlight) || false
            const timestamp = Number(res.extra.timestamp) || null
            // const blockRef = res.extra.blockRef

            if (greenlight) {
                log.debug(
                    "[SEND OUR VALIDATOR PHASE] SendStatus callback received greenlight",
                )
                log.debug(`Response.extra: ${JSON.stringify(res.extra)}`)

                // INFO: Resolve the waiter with the timestamp
                return Waiter.resolve<number>(waiterKey, timestamp)
            }

            return null
        }

        // INFO: Send the request and handle the response non-blocking

        try {
            sendStatus()
                .then(handleSendStatusRes)
                .catch((error: Error) => {
                    log.error(
                        `Error sending our validator phase to the secretary: ${error}`,
                    )
                    console.error(error)
                })
            // INFO: Wait for the green light
            log.debug("[SEND OUR VALIDATOR PHASE] Waiting for the green light")
            const greenlightRes = await greenlight
            log.debug(
                `[SEND OUR VALIDATOR PHASE] Green light waiter resolved with: ${greenlightRes}`,
            )
            return greenlightRes
        } catch (error) {
            log.error(`Error waiting for the green light: ${error}`)
            if (error instanceof TimeoutError) {
                log.warning(
                    "[SEND OUR VALIDATOR PHASE] Timeout waiting for green light",
                )
            }

            if (error instanceof AbortError) {
                log.debug(
                    "[SEND OUR VALIDATOR PHASE] AbortError caught, resolving with null",
                )

                return null
            }

            await this.handleSecretaryGoneOffline()

            // INFO: Resend the request and handle the response
            const res = await sendStatus()
            return await handleSendStatusRes(res)
        }
    }

    public async endConsensusRoutine() {
        log.debug("Ending the consensus routine")
        const manager = SecretaryManager.instances.get(this.shard.blockRef)

        if (manager) {
            manager.runSecretaryRoutine = false
        }
        const filter = (key: string) =>
            key.includes("greenLight" + this.shard.blockRef)

        const waiterKeys = Array.from(Waiter.waitList.keys()).filter(filter)
        const waiters = waiterKeys.map(key => Waiter.wait(key))

        log.debug(
            "💁💁💁💁💁💁💁💁 WAITING FOR HANGING GREENLIGHTS 💁💁💁💁💁💁💁💁💁💁",
        )
        log.debug(`Waiter keys: ${JSON.stringify(waiterKeys)}`)
        try {
            await Promise.all(waiters)
        } catch (error) {
            log.error(
                `[SECRETARY] Error waiting for hanging greenlights: ${error}`,
            )
            process.exit(1)
        }

        // INFO: Delete pre-held keys for ended consensus round
        Waiter.preHeld
            .keys()
            .filter(filter)
            .forEach(key => Waiter.preHeld.delete(key))

        log.debug("HANGING GREENLIGHTS RESOLVED")
        log.debug("[SECRETARY ROUTINE] Secretary routine finished 🎉")

        Waiter.abort(Waiter.keys.SET_WAIT_STATUS)

        if (SecretaryManager.getInstance(this.shard.blockRef) === this) {
            log.debug("deleting the instance")
            SecretaryManager.instances.delete(this.shard.blockRef)
        }

        // SecretaryManager.instance = null
        // TODO: Abort all waiters

        // INFO: Resolve all hanging waiters
        // if (Waiter.isWaiting(Waiter.keys.GREEN_LIGHT)) {
        //     log.debug(
        //         "GREEN_LIGHT waiter found WHEN ENDING THE CONSENSUS ..., KILLING IT it",
        //     )
        //     Waiter.abort(Waiter.keys.GREEN_LIGHT)
        // }

        // if (Waiter.isWaiting(Waiter.keys.SET_WAIT_STATUS)) {
        //     log.debug(
        //         "SET_WAIT_STATUS waiter found WHEN ENDING THE CONSENSUS ..., KILLING IT it",
        //     )
        //     Waiter.abort(Waiter.keys.SET_WAIT_STATUS)
        // }
    }

    // SECTION Methods called by the shard members
    /**
     * Setting the status of a phase for the local validator
     *
     * @param phase The phase number
     * @param status The boolean value to set
     */
    async setOurValidatorPhase(phase: number, status: boolean) {
        log.debug(`[setOurValidatorPhase] Setting our phase to: ${phase}`)
        // INFO: Update the current phase and the status of the phase
        this.ourValidatorPhase.currentPhase = phase
        this.ourValidatorPhase.phases[phase][1] = status
        this.ourValidatorPhase.waitStatus = true
    }

    // ANCHOR Singleton logic
    public static getInstance(
        blockRef?: number,
        initialize = false,
    ): SecretaryManager {
        // INFO: If blockRef is not provided, use the last block number + 1
        // ie. assume we're using this instance for latest block
        if (!blockRef) {
            blockRef = getSharedState.lastBlockNumber + 1
        }

        if (!SecretaryManager.instances.get(blockRef)) {
            if (initialize) {
                SecretaryManager.instances.set(blockRef, new SecretaryManager())
            } else {
                return null
            }
        }

        return SecretaryManager.instances.get(blockRef)
    }

    /**
     * Gets the block timestamp from the secretary
     *
     * @returns The block timestamp or null if there was an error
     */
    public async getSecretaryBlockTimestamp() {
        const request: RPCRequest = {
            method: "consensus_routine",
            params: [{ method: "getBlockTimestamp" }],
        }

        const res = await this.secretary.call(request)

        if (res.result === 200) {
            this.blockTimestamp = res.response[0] as number
            return this.blockTimestamp
        }

        log.error(
            `[SECRETARY MANAGER] Error getting the block timestamp from the secretary: ${res.result}`,
        )
        return null
    }
}
