import { Peer } from "src/libs/peer"
import { ValidationPhase } from "./validationStatusTypes"

export interface Shard {
    CVSA: string // The common validator seed used to generate the members
    members: Peer[] // The members of the shard
    validationPhases: { [key: string]: ValidationPhase } // The validation phases for each member
    secretaryKey: string // The key of the secretary
    blockRef: number // The block reference for the shard
}