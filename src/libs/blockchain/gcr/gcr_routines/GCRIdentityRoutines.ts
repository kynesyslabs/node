import { GCRMain } from "@/model/entities/GCRv2/GCR_Main"
import { GCRResult } from "../handleGCR"
import { GCREdit } from "@kynesyslabs/demosdk/types"
import { Repository } from "typeorm"
import log from "@/utilities/logger"

export default class GCRIdentityRoutines {
    // TODO: Implement these
    static async applyXmIdentityAdd() {}
    static async applyXmIdentityRemove() {}
    // static async applyWeb2IdentityAdd() {}
    // static async applyWeb2IdentityRemove() {}

    static async apply(
        editOperation: GCREdit,
        gcrMainRepository: Repository<GCRMain>,
        simulate: boolean,
    ): Promise<GCRResult> {
        // INFO: Debug breakpoint
        log.only("[GCRIdentityRoutines] Applying identity")
        log.only(JSON.stringify(editOperation))
        process.exit(1)

        return { success: true, message: "Identity applied" }
    }
}
