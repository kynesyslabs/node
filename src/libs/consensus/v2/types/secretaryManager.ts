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

    constructor() {}

    // Creating a shard from the CVSA
    // ! Replace the old method called in PoRBFT.ts with this one as we will use this class to manage the shard
    async initializeShard(CVSA: string) {
        this.shard = {
            CVSA: CVSA,
            members: [],
            validationPhases: {},
            secretaryKey: "",
            blockRef: 0,
        }
        // Reusing the method to create the members
        this.shard.members = await getShard(CVSA)
        // Assigning the secretary and its key
        this.shard.secretaryKey = this.secretary.identity
        this.ourKey = getSharedState.identity.ed25519.publicKey.toString("hex")

        log.debug("INITIALIZED SHARD:")
        log.debug(
            "SHARD: " +
                JSON.stringify(
                    this.shard.members.map(m => m.identity.toString("hex")),
                ),
        )
        log.debug("SECRETARY: " + this.secretary.identity.toString("hex"))

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

        while (this.runSecretaryRoutine) {
            log.info("[SECRETARY ROUTINE] Waiting for the set wait status")
            await Waiter.wait(Waiter.keys.SET_WAIT_STATUS)
            log.debug("[SECRETARY ROUTINE] SET_WAIT_STATUS Lock resolved")
        }
    }

    /**
     * Setting the current phase for a specific member
     *
     * @param memberKey The public key of the member
     * @param currentPhase The current phase to set, a ValidationPhaseStatus or a number
     * @param waitingForStatus The member's wait status
     */
    public setCurrentPhase(
        memberKey: string,
        currentPhase: ValidationPhaseStatus | number,
        waitingForStatus: boolean = false,
    ) {
        if (!this.checkIfWeAreSecretary()) {
            throw new Error("Only the Secretary can set the current phase")
        }

        // Setting the current phase
        if (typeof currentPhase === "number") {
            this.shard.validationPhases[memberKey].currentPhase = currentPhase
        } else {
            // Inferring the current phase number from the string
            let currentPhaseNumber = 0
            let found = false
            for (const phase of Object.values(emptyValidationPhase.phases)) {
                currentPhaseNumber++
                if (phase[0] === currentPhase) {
                    found = true
                    break
                }
            }
            if (!found) {
                throw new Error("Current phase not found") // REVIEW Handle nicely
            }
            this.shard.validationPhases[memberKey].currentPhase =
                currentPhaseNumber
        }

        // Setting the wait status
        this.shard.validationPhases[memberKey].waitStatus = waitingForStatus
    }

    /**
     * Receives the wait status from a validator. Called from the endpoint handler.
     *
     * @param memberKey The public key of the member
     * @param waitStatus The wait status to set
     */
    public async receiveWaitStatus(memberKey: string, waitStatus: boolean) {
        required(
            this.checkIfWeAreSecretary(),
            "Only the Secretary can receive the wait status",
        )

        this.shard.validationPhases[memberKey].waitStatus = waitStatus
    }

    public async receiveValidatorPhase(memberKey: string, phase: number) {
        log.debug("OUR PHASE: " + this.ourValidatorPhase.currentPhase)
        log.debug("RECEIVED PHASE: " + phase)

        this.shard.validationPhases[memberKey].currentPhase = phase
        this.shard.validationPhases[memberKey].phases[phase][1] = true
        this.shard.validationPhases[memberKey].waitStatus = true

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
                        // params: [member, false],
                    },
                ],
            }

            log.debug(`[SECRETARY ROUTINE] Sending greenlight to ${pubKey}`)
            const member = this.shard.members.find(m => m.identity === pubKey)
            promises.push(member.call(request))
        }

        await Promise.all(promises)
    }

    public async receiveGreenLight() {
        Waiter.resolve(Waiter.keys.GREEN_LIGHT)
        this.ourValidatorPhase.waitStatus = false
    }

    /**
     * Gets the members that are waiting for the green light
     *
     * @returns The list of members that are waiting for the green light
     */
    public getWaitingMembers() {
        const ourPhase = this.ourValidatorPhase.currentPhase
        const waitingMembers = []

        for (const [pubKey, phase] of Object.entries(
            this.shard.validationPhases,
        )) {
            if (phase.currentPhase === ourPhase && phase.waitStatus) {
                waitingMembers.push(pubKey)
            }
        }

        return waitingMembers
    }

    // Setting the wait status for a specific member
    // ? Is this method needed as we can set the wait status directly in the setCurrentPhase method?
    public async setWaitStatus() {
        // if (!this.checkIfWeAreSecretary()) {
        //     throw new Error("Only the Secretary can set the wait status")
        // }
        // // Setting the wait status
        // this.shard.validationPhases[memberKey].waitStatus = waitStatus

        // const weAreSecretary = this.checkIfWeAreSecretary()

        // if (weAreSecretary) {
        //     this.shard.validationPhases[this.ourKey].waitStatus = true
        //     // INFO: Wait for our green light
        //     return await Waiter.wait(Waiter.keys.GREEN_LIGHT)
        // }

        return await this.sendOurValidatorPhaseToSecretary()
    }

    /**
     * Sends our local validator phase to the secretary and waits for the green light
     */
    private async sendOurValidatorPhaseToSecretary() {
        const request: RPCRequest = {
            method: "consensus_routine",
            params: [
                {
                    method: "setValidatorPhase",
                    // REVIEW: Do we need to send our public key?
                    // What if a malicious node sends the wrong key?
                    params: [this.ourKey, this.ourValidatorPhase.currentPhase],
                },
            ],
        }

        log.debug("Sending setValidatorPhase request to the secretary")
        log.debug("Secretary is: " + this.secretary.identity)
        const res = await this.secretary.longCall(request, true, 1000, 10)
        console.log(res)

        // FIXME: Handle the secretary not being in the consensus routine

        // INFO: Wait for the green light
        return await Waiter.wait(Waiter.keys.GREEN_LIGHT)
    }

    public async endConsensusRoutine() {
        SecretaryManager.instance = null
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
