import { RPCResponse } from "@kynesyslabs/demosdk/types"
import { getSharedState } from "src/utilities/sharedState"
import { emptyResponse } from "src/libs/network/server_rpc"
import _ from "lodash"
import { Peer } from "src/libs/peer"
import {
    emptyValidatorStatus,
    getShardManager,
    ValidatorStatus,
} from "./shardManager"
import log from "src/utilities/logger"

/** NOTE
 * This class is used both by the secretary itself and the other shard partecipants.
 * The secretary will use it to update, retrieve and broadcast the statuses of the other shard partecipants.
 * The shard partecipants will use it as a local cache of the statuses of the other partecipants as stored in the secretary.
 */
class Secretary {
    private static instance: Secretary
    private secretary: Peer
    private status: Map<string, ValidatorStatus> = new Map()

    constructor() {
        this.secretary = getShardManager.getShard()[0]
        log.custom(
            "secretary",
            "The secretary for this shard round is: " + this.secretary.identity,
        )
        log.custom(
            "secretary",
            JSON.stringify(this.secretary, null, 2),
            false,
            true,
        )
        log.custom(
            "secretary",
            "The shard and secretary have been initialized using the following seed: " +
                getSharedState.lastShardSeed,
            false,
            true,
        )
        for (const peer of getShardManager.getShard()) {
            // Using a deep copy of the emptyValidatorStatus to avoid any reference issues
            if (!this.status.has(peer.identity)) {
                this.status.set(
                    peer.identity,
                    _.cloneDeep(emptyValidatorStatus),
                )
            }
        }
    }

    public static getInstance(): Secretary {
        if (!Secretary.instance) {
            Secretary.instance = new Secretary()
        }
        return Secretary.instance
    }

    public setStatus(peerKey: string, status: ValidatorStatus): RPCResponse {
        let response: RPCResponse = _.cloneDeep(emptyResponse)
        // Creating a deep copy of the status if it is not yet in the map
        if (!this.status.has(peerKey)) {
            this.status.set(peerKey, _.cloneDeep(emptyValidatorStatus))
        }
        // Setting the status
        this.status.set(peerKey, status)
        response.result = 200
        response.response = this.status
        response.extra = getSharedState.currentTimestamp
        log.custom(
            "secretary",
            "The status has been updated for " +
                peerKey +
                " with the following status: " +
                JSON.stringify(status, null, 2),
            false,
            true,
        )
        return response
    }

    public setAllStatus(
        status: Map<string, ValidatorStatus>,
    ): Map<string, ValidatorStatus> {
        this.status = status
        log.custom(
            "secretary",
            "The status has been updated for all the shard with the following status: " +
                JSON.stringify(status, null, 2),
            false,
            true,
        )
        return this.getAllStatus()
    }

    public getStatus(peerKey: string): ValidatorStatus {
        log.custom(
            "secretary",
            "The status has been retrieved for " +
                peerKey +
                " with the following status: " +
                JSON.stringify(this.status.get(peerKey), null, 2),
            false,
            true,
        )
        return this.status.get(peerKey)
    }

    public getAllStatus(): Map<string, ValidatorStatus> {
        log.custom(
            "secretary",
            "The status has been retrieved for all the shard with the following status: " +
                JSON.stringify(this.status, null, 2),
            false,
            true,
        )
        return this.status
    }
}

export default Secretary
