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

// ANCHOR SecretaryManager
export default class SecretaryManager {
    private static instance: SecretaryManager

    // Internal variables
    public shard: Shard

    constructor() {
    }

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
        this.shard.secretaryKey = this.shard.members[0].identity
        // Initializing the validation phases
        this.initializeValidationPhases()
    }

    // Initializing the validation phases for each member of the shard to the empty validation phase
    public initializeValidationPhases() {
        for (const member of this.shard.members) {
            this.shard.validationPhases[member.identity] = _.cloneDeep(emptyValidationPhase)
        }
    }

    // SECTION Methods called by the Secretary only

    // REVIEW Base check to see if we are the secretary, called by all the methods that the Secretary can call
    public checkIfWeAreSecretary() {
        return this.shard.secretaryKey === ForgeToHex(getSharedState.identity.ed25519.publicKey)
    }

    // Setting the current phase for a specific member
    public setCurrentPhase(memberKey: string, currentPhase: ValidationPhaseStatus | number, waitingForStatus: boolean = false) {
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
            this.shard.validationPhases[memberKey].currentPhase = currentPhaseNumber
        }
        // Setting the wait status
        this.shard.validationPhases[memberKey].waitStatus = waitingForStatus
    }

    // Setting the wait status for a specific member
    // ? Is this method needed as we can set the wait status directly in the setCurrentPhase method?
    public setWaitStatus(memberKey: string, waitStatus: boolean) {
        if (!this.checkIfWeAreSecretary()) {
            throw new Error("Only the Secretary can set the wait status")
        }
        // Setting the wait status
        this.shard.validationPhases[memberKey].waitStatus = waitStatus
    }

    // TODO Routine to check for waiting validators and update their status / give them green light
    async checkForWaitingValidators() { // REVIEW Must be called asynchronously to avoid blocking the thread
        // ! Implement
        // TODO Cycle through all the members and check if they are waiting for a status
        // TODO If they are, check which phase they are waiting for
        // TODO Then, check all the other members if they have already reached the phase they are waiting for
        // TODO If they have, update the waiting validator's status to false and give the green light
        // TODO If they haven't, do nothing and wait; then repeat the check after a while
    }

    // SECTION Methods called by the shard members


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
