import { ValidityData } from "@kynesyslabs/demosdk/types"
import { DTRManager } from "../dtr/dtrmanager"
import eggs from "../routines/eggs"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"

export const miscHandlers: Record<string, NodeCallHandler> = {
    RELAY_TX: async (data, _response) => {
        return await DTRManager.receiveRelayedTransactions(
            data as ValidityData[],
        )
    },

    hots: async (_data, response) => {
        log.debug("[SERVER] Received hots")
        response.response = eggs.hots()
        return response
    },
}
