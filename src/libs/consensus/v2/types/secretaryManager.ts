import {
    ValidationPhase,
    emptyValidationPhase,
    ValidationPhaseStatus,
} from "./validationStatusTypes"
import { Shard } from "./shardTypes"
import { Peer } from "src/libs/peer"
import { getSharedState } from "src/utilities/sharedState"
import getShard from "../routines/getShard"
import _ from "lodash"
import { ForgeToHex, HexToForge } from "src/libs/crypto/forgeUtils"
import { Waiter } from "src/utilities/waiter"
import { _required as required } from "@kynesyslabs/demosdk/websdk"
import { RPCRequest } from "@kynesyslabs/demosdk/types"
import log from "src/utilities/logger"
import { TimeoutError } from "src/exceptions"

// ANCHOR SecretaryManager
export default class SecretaryManager {
    private static instance: SecretaryManager

    // Internal variables
    public shard: Shard
    public get secretary() {
        return this.shard.members[0]
    }

    public ourValidatorPhase: ValidationPhase
    public ourKey: string
    public runSecretaryRoutine: boolean = false
    public blockTimestamp: number

    constructor() {}

    /**
     * Initializes the shard, including the members and the validation phases.
     *
     * @param CVSA The CVSA string
     * @param lastBlockNumber The last block number
     * @returns The list of shard members
     */
    async initializeShard(CVSA: string, lastBlockNumber: number) {
        this.shard = {
            CVSA: CVSA,
            members: [],
            validationPhases: {},
            secretaryKey: "",
            blockRef: lastBlockNumber + 1,
        }

        // Reusing the method to create the members
        this.shard.members = await getShard(CVSA)
        // Assigning the secretary and its key
        this.shard.secretaryKey = this.secretary.identity
        this.ourKey = getSharedState.identity.ed25519.publicKey.toString("hex")

        log.debug("INITIALIZED SHARD:")
        log.debug(
            "SHARD: " + JSON.stringify(this.shard.members.map(m => m.identity)),
        )
        log.debug("SECRETARY: " + this.secretary.identity)

        // INFO: Start the secretary routine
        if (this.checkIfWeAreSecretary()) {
            this.secretaryRoutine()
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
        return (
            this.shard.secretaryKey ===
            ForgeToHex(getSharedState.identity.ed25519.publicKey)
        )
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

        this.blockTimestamp = Math.floor(Date.now() / 1000)

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
                    await Waiter.wait(Waiter.keys.SET_WAIT_STATUS)
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
                    await this.handleNodesGoneOffline(waitingMembers)

                    // NOTE: We don't await this. We just trigger it and continue the routine
                    this.releaseWaitingMembers(waitingMembers)
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
            "Maybe offline members: " +
                maybeOfflineMembers.map(m => m.identity),
        )

        for (const member of maybeOfflineMembers) {
            const isStillThere = await member.connect()

            if (!isStillThere) {
                log.debug(
                    `[SECRETARY ROUTINE] ${member.identity} is offline, removing from the shard`,
                )

                this.shard.members = this.shard.members.filter(
                    m => m.identity !== member.identity,
                )
                delete this.shard.validationPhases[member.identity]
                break
            }

            log.debug(
                `[SECRETARY ROUTINE] ${member.identity} is still online, what should we do?`,
            )
        }
    }

    /**
     * Handles the secretary going offline
     *
     * Ping the secretary to check if it's still online
     * If it's not, we elect the second node as the new secretary
     */
    public async handleSecretaryGoneOffline() {
        log.debug("[SECRETARY ROUTINE] Handling secretary going offline")
        const isOnline = await this.secretary.connect()

        if (isOnline) {
            // REVIEW: Is that it?
            log.debug("Secretary is still online, nothing to do")
            return
        }

        log.debug(
            "Secretary is offline, electing the second node as the new secretary",
        )

        const weAreSecond = this.shard.members[1].identity === this.ourKey

        if (weAreSecond) {
            const exSecretary = this.secretary.identity
            this.shard.secretaryKey = this.shard.members[1].identity
            // remove secretary from the list of members
            this.shard.members = this.shard.members.filter(
                m => m.identity !== exSecretary,
            )
            delete this.shard.validationPhases[exSecretary]

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
                // TODO: Check if we can release the waiting nodes
            }
        } else {
            // TODO: Handle the case where the secretary is offline and we are not the second node
            // Send the validator phase to the new secretary

            log.debug("We are not the second node. Panicking ...")
            process.exit(0)
        }
    }

    /**
     * Simulates the secretary going offline.
     * If we're forging block x = 5, kill the node if it's the secretary
     */
    public async simulateSecretaryGoingOffline() {
        const weAreForgingBlock = this.shard.blockRef == 5
        const weAreSecretary = this.checkIfWeAreSecretary()

        if (weAreForgingBlock && weAreSecretary) {
            log.debug("We are forging block #5 and we are the secretary")
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
        const weAreForgingBlock10 = this.shard.blockRef == 5
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

    public async receiveValidatorPhase(memberKey: string, phase: number) {
        log.debug("OUR PHASE: " + this.ourValidatorPhase.currentPhase)
        log.debug("RECEIVED PHASE: " + phase)

        log.debug(JSON.stringify(this.shard, null, 2))

        this.shard.validationPhases[memberKey].currentPhase = phase
        this.shard.validationPhases[memberKey].phases[phase][1] = true
        this.shard.validationPhases[memberKey].waitStatus = true

        if (!this.checkIfWeAreSecretary()) {
            return
        }

        // INFO: Check if node is behind us
        if (phase < this.ourValidatorPhase.currentPhase) {
            log.debug(
                `[SECRETARY ROUTINE] Releasing ${memberKey} as they are behind us`,
            )
            this.releaseWaitingMembers([memberKey])
        }

        const shouldRelease = this.shouldReleaseWaitingMembers()
        log.debug(
            `[SECRETARY ROUTINE] Should release the waiting members? ${shouldRelease}`,
        )

        // INFO: Check if that peer was the one holding the green light
        if (shouldRelease) {
            // INFO: If we are in the last phase, stop the secretary routine
            if (this.ourValidatorPhase.currentPhase == 7) {
                this.runSecretaryRoutine = false
            }

            // INFO: Release the waiting members
            Waiter.resolve(Waiter.keys.SET_WAIT_STATUS)
            await this.releaseWaitingMembers()
            log.debug("[SECRETARY ROUTINE] Released the waiting members")
        }
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
    public async releaseWaitingMembers(waitingMembers: string[] = []) {
        // INFO: Release the waiting members
        // When members are provided, skip check
        if (waitingMembers.length == 0) {
            waitingMembers = this.getWaitingMembers()
        }
        const promises = []

        for (const pubKey of waitingMembers) {
            const request: RPCRequest = {
                method: "consensus_routine",
                params: [
                    {
                        method: "greenlight",
                        params: [
                            this.blockTimestamp,
                            this.ourValidatorPhase.currentPhase,
                        ],
                    },
                ],
            }

            log.debug(
                `[SECRETARY ROUTINE] Sending greenlight to ${pubKey} with timestamp ${this.blockTimestamp} and phase ${this.ourValidatorPhase.currentPhase}`,
            )
            // INFO: Update the wait status of the member to false
            this.shard.validationPhases[pubKey].waitStatus = false

            log.debug(`[SECRETARY ROUTINE] Sending greenlight to ${pubKey}`)
            const member = this.shard.members.find(m => m.identity === pubKey)
            promises.push(member.call(request))
        }

        await Promise.all(promises)
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
        log.debug("Received green light for phase: " + validatorPhase)
        const waiterKey = Waiter.keys.GREEN_LIGHT + validatorPhase
        if (!this.ourValidatorPhase) {
            log.debug("Our phase is undefined, doing nothing")
            return
        }

        log.debug("Our phase: " + this.ourValidatorPhase.currentPhase)
        if (validatorPhase !== this.ourValidatorPhase.currentPhase) {
            // INFO: This node has already timed out
            log.debug("We are not in the same phase, stopping the node ...")
            process.exit(1)
        }

        Waiter.resolve(waiterKey, secretaryBlockTimestamp)
        this.ourValidatorPhase.waitStatus = false
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
     */
    public async sendOurValidatorPhaseToSecretary(retries: number = 3) {
        // INFO: Enable code to simulate node failures
        // if (this.ourValidatorPhase.currentPhase == 4) {
        //     log.debug(
        //         "We are deep in the consensus, try: simulating a node going offline",
        //     )
        //     // await this.simulateNormalNodeGoingOffline()
        //     // await this.simulateSecretaryGoingOffline()
        // }
        const waiterKey =
            Waiter.keys.GREEN_LIGHT + this.ourValidatorPhase.currentPhase
        const greenlight = Waiter.wait(waiterKey)

        const sendStatus = async () => {
            const request: RPCRequest = {
                method: "consensus_routine",
                params: [
                    {
                        method: "setValidatorPhase",
                        // REVIEW: Do we need to send our public key?
                        // What if a malicious node sends the wrong key?
                        params: [
                            this.ourKey,
                            this.ourValidatorPhase.currentPhase,
                        ],
                    },
                ],
            }

            log.debug("Sending setValidatorPhase request to the secretary")
            log.debug("Secretary is: " + this.secretary.identity)
            return await this.secretary.longCall(request, true, 1000, retries)
        }

        sendStatus().then(async res => {
            log.debug("Set validator phase response: " + res)

            if (res.result == 500 || res.result == 400) {
                if (!Waiter.isWaiting(waiterKey)) {
                    log.debug(
                        "[SECRETARY ROUTINE] Key has already been resolved, doing nothing",
                    )
                    return
                }

                await this.handleSecretaryGoneOffline()
                await sendStatus()
            }
        })

        // FIXME: Handle the secretary not being in the consensus routine

        try {
            // INFO: Wait for the green light
            log.debug("[SECRETARY ROUTINE] Waiting for the green light")
            return await greenlight
        } catch (error) {
            log.error("Error waiting for the green light: " + error)
            if (error instanceof TimeoutError) {
                log.warning(
                    "[SECRETARY ROUTINE] Timeout waiting for green light",
                )
            }

            await this.handleSecretaryGoneOffline()
            await sendStatus()
        }
    }

    public async endConsensusRoutine() {
        SecretaryManager.instance = null

        // INFO: Resolve all hanging waiters
        if (Waiter.isWaiting(Waiter.keys.GREEN_LIGHT)) {
            log.debug(
                "GREEN_LIGHT waiter found WHEN ENDING THE CONSENSUS ..., resolving it",
            )
            Waiter.resolve(Waiter.keys.GREEN_LIGHT)
        }

        if (Waiter.isWaiting(Waiter.keys.SET_WAIT_STATUS)) {
            log.debug(
                "SET_WAIT_STATUS waiter found WHEN ENDING THE CONSENSUS ..., resolving it",
            )
            Waiter.resolve(Waiter.keys.SET_WAIT_STATUS)
        }
    }

    // SECTION Methods called by the shard members
    /**
     * Setting the status of a phase for the local validator
     *
     * @param phase The phase number
     * @param status The boolean value to set
     */
    async setOurValidatorPhase(phase: number, status: boolean) {
        log.debug("[setOurValidatorPhase] Setting our phase to: " + phase)
        // INFO: Update the current phase and the status of the phase
        this.ourValidatorPhase.currentPhase = phase
        this.ourValidatorPhase.phases[phase][1] = status
        this.ourValidatorPhase.waitStatus = true
    }

    // SECTION Public methods
    public async getSecretaryKey() {
        return this.shard.secretaryKey
    }

    public async getCurrentPhase(memberKey: string) {
        return this.shard.validationPhases[memberKey].currentPhase
    }

    public async getWaitStatus(memberKey: string) {
        return this.shard.validationPhases[memberKey].waitStatus
    }

    // ANCHOR Singleton logic
    public static getInstance(): SecretaryManager {
        if (!SecretaryManager.instance) {
            SecretaryManager.instance = new SecretaryManager()
        }
        return SecretaryManager.instance
    }
}
