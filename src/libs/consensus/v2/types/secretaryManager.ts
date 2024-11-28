// TODO Move shardManager and secretary to this class
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
    private static secretaryVotes: string[] = []

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

    // Creating a shard from the CVSA
    // ! Replace the old method called in PoRBFT.ts with this one as we will use this class to manage the shard
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

    // Initializing the validation phases for each member of the shard to the empty validation phase
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

    async secretaryRoutine() {
        required(
            this.checkIfWeAreSecretary(),
            "Only the Secretary can run this routine",
        )
        this.runSecretaryRoutine = true
        for (const member of this.shard.members) {
            const waiterId =
                member.identity + Waiter.keys.WAIT_FOR_SECRETARY_ROUTINE

            if (Waiter.isWaiting(waiterId)) {
                Waiter.resolve(waiterId)
            }
        }

        this.blockTimestamp = Math.floor(Date.now() / 1000)

        while (this.runSecretaryRoutine) {
            try {
                if (Waiter.isWaiting(Waiter.keys.SET_WAIT_STATUS)) {
                    log.debug("[SECRETARY ROUTINE] Existing SET_WAIT_STATUS waiter found. Waiting for that one ...")
                    await Waiter.waitList.get(Waiter.keys.SET_WAIT_STATUS).promise
                } else {
                    log.debug("[SECRETARY ROUTINE] Waiting for the set wait status")
                    await Waiter.wait(Waiter.keys.SET_WAIT_STATUS)
                    log.debug("[SECRETARY ROUTINE] SET_WAIT_STATUS Lock resolved")
                }

            } catch (error) {
                log.error(
                    "[SECRETARY ROUTINE] Error waiting for SET_WAIT_STATUS:",
                )

                log.error(error as string)

                if (error instanceof TimeoutError) {
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
        log.debug("Maybe offline members: " + maybeOfflineMembers.map(m => m.identity))

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
            log.debug("Secretary is online, nothing to do")
            return
        }

        log.debug(
            "Secretary is offline, electing the second node as the new secretary",
        )

        const areWeSecond = this.shard.members[1].identity === this.ourKey

        if (areWeSecond) {
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
            }
        }
    }

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
     * Simulates a normal node going offline
     *
     * If we're forging block #10, kill normal this node if it's not the secretary
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
        return
    }

    /**
     * Setting the current phase for a specific member
     *
     * @param memberKey The public key of the member
     * @param currentPhase The current phase to set, a ValidationPhaseStatus or a number
     * @param waitingForStatus The member's wait status
     */
    // public setCurrentPhase(
    //     memberKey: string,
    //     currentPhase: ValidationPhaseStatus | number,
    //     waitingForStatus: boolean = false,
    // ) {
    //     if (!this.checkIfWeAreSecretary()) {
    //         throw new Error("Only the Secretary can set the current phase")
    //     }

    //     // Setting the current phase
    //     if (typeof currentPhase === "number") {
    //         this.shard.validationPhases[memberKey].currentPhase = currentPhase
    //     } else {
    //         // Inferring the current phase number from the string
    //         let currentPhaseNumber = 0
    //         let found = false
    //         for (const phase of Object.values(emptyValidationPhase.phases)) {
    //             currentPhaseNumber++
    //             if (phase[0] === currentPhase) {
    //                 found = true
    //                 break
    //             }
    //         }
    //         if (!found) {
    //             throw new Error("Current phase not found") // REVIEW Handle nicely
    //         }
    //         this.shard.validationPhases[memberKey].currentPhase =
    //             currentPhaseNumber
    //     }

    //     // Setting the wait status
    //     this.shard.validationPhases[memberKey].waitStatus = waitingForStatus
    // }

    /**
     * Receives the wait status from a validator. Called from the endpoint handler.
     *
     * @param memberKey The public key of the member
     * @param waitStatus The wait status to set
     */
    // public async receiveWaitStatus(memberKey: string, waitStatus: boolean) {
    //     required(
    //         this.checkIfWeAreSecretary(),
    //         "Only the Secretary can receive the wait status",
    //     )

    //     this.shard.validationPhases[memberKey].waitStatus = waitStatus
    // }

    public async receiveValidatorPhase(memberKey: string, phase: number) {
        log.debug("OUR PHASE: " + this.ourValidatorPhase.currentPhase)
        log.debug("RECEIVED PHASE: " + phase)

        log.debug(JSON.stringify(this.shard, null, 2))

        this.shard.validationPhases[memberKey].currentPhase = phase
        this.shard.validationPhases[memberKey].phases[phase][1] = true
        this.shard.validationPhases[memberKey].waitStatus = true

        if (!this.checkIfWeAreSecretary()){
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
                        params: [this.blockTimestamp, this.ourValidatorPhase.currentPhase],
                    },
                ],
            }

            log.debug(`[SECRETARY ROUTINE] Sending greenlight to ${pubKey} with timestamp ${this.blockTimestamp} and phase ${this.ourValidatorPhase.currentPhase}`)
            // INFO: Update the wait status of the member to false
            this.shard.validationPhases[pubKey].waitStatus = false

            log.debug(`[SECRETARY ROUTINE] Sending greenlight to ${pubKey}`)
            const member = this.shard.members.find(m => m.identity === pubKey)
            promises.push(member.call(request))
        }

        await Promise.all(promises)
    }

    public async receiveGreenLight(secretaryBlockTimestamp?: number, validatorPhase?: number) {
        log.debug("Received green light for phase: " + validatorPhase)
        const waiterKey = Waiter.keys.GREEN_LIGHT + validatorPhase
        if (!this.ourValidatorPhase){
            log.debug("Our phase is undefined, doing nothing")
            return
        }

        log.debug("Our phase: " + this.ourValidatorPhase.currentPhase)
        if (validatorPhase !== this.ourValidatorPhase.currentPhase) {
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
        // if (this.ourValidatorPhase.currentPhase == 4) {
        //     log.debug(
        //         "We are deep in the consensus, try: simulating a node going offline",
        //     )
        //     // await this.simulateNormalNodeGoingOffline()
        //     // await this.simulateSecretaryGoingOffline()
        // }
        const waiterKey = Waiter.keys.GREEN_LIGHT + this.ourValidatorPhase.currentPhase
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

        sendStatus().then(async(res) => {
            log.debug("Set validator phase response: " + res)

            if (res.result == 500 || res.result == 400) {
                if (!Waiter.isWaiting(waiterKey)){
                    log.debug("[SECRETARY ROUTINE] Key has already been resolved, doing nothing")
                    return
                }

                await this.handleSecretaryGoneOffline()
                await sendStatus()
            }
        })

        // const res = await sendStatus()
        // console.log(res)

        // INFO: If secretary is offline, or longCall failed!
        // if (res.result == 500 || res.result == 400) {
        //     await this.handleSecretaryGoneOffline()
        //     const res = await sendStatus()
        //     console.log(res)
        // }

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

        if (Waiter.isWaiting(Waiter.keys.GREEN_LIGHT)){
            Waiter.resolve(Waiter.keys.GREEN_LIGHT)
        }

        if (Waiter.isWaiting(Waiter.keys.SET_WAIT_STATUS)){
            Waiter.resolve(Waiter.keys.SET_WAIT_STATUS)
        }
    }

    // TODO Routine to check for waiting validators and update their status / give them green light
    async checkForWaitingValidators() {
        // REVIEW Must be called asynchronously to avoid blocking the thread
        // ! Implement
        // TODO Cycle through all the members and check if they are waiting for a status
        // TODO If they are, check which phase they are waiting for
        // TODO Then, check all the other members if they have already reached the phase they are waiting for
        // TODO If they have, update the waiting validator's status to false and give the green light
        // TODO If they haven't, do nothing and wait; then repeat the check after a while
    }

    // SECTION Methods called by the shard members
    /**
     * Setting the status of a phase for the local validator
     *
     * @param phase The phase number
     * @param status The boolean value to set
     */
    async setOurValidatorPhase(phase: number, status: boolean) {
        console.log("phase", phase)
        // INFO: Update the current phase and the status of the phase
        console.log(this.ourValidatorPhase.phases)
        console.log(this.ourValidatorPhase.phases[phase])
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
