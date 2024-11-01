import { assignWeb2 } from "./assignWeb2"
import { assignXM } from "./assignXM"
import hashGCRTables from "./hashGCR"
import native from "./manageNative"

let glsRoutines = {
    assignWeb2: assignWeb2,
    assignXM: assignXM,
    native: native,
    hashGCRTables: hashGCRTables,
}

export default glsRoutines
