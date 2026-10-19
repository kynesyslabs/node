import eggs from "../routines/eggs"
import log from "src/utilities/logger"
import type { NodeCallHandler } from "./types"

export const miscHandlers: Record<string, NodeCallHandler> = {
    hots: async (_data, response) => {
        log.debug("[SERVER] Received hots")
        response.response = eggs.hots()
        return response
    },
}
