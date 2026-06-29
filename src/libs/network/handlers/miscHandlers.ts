import { ValidityData } from "@kynesyslabs/demosdk/types"
import { DTRManager } from "../dtr/dtrmanager"
import eggs from "../routines/eggs"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"
import Mempool from "@/libs/blockchain/mempool"

export const miscHandlers: Record<string, NodeCallHandler> = {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    RELAY_TX: async (data, _response) => {
        return await Mempool.lock.runExclusive(
            async () =>
                await DTRManager.receiveRelayedTransactions(
                    data as {
                        payload: ValidityData[]
                        blockNumber: number
                        blockRef: string
                    },
                ),
        )
    },

    hots: async (_data, response) => {
        log.debug("[SERVER] Received hots")
        response.response = eggs.hots()
        return response
    },
}
