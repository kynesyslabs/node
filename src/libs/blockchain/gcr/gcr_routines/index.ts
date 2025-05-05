import { assignWeb2 } from "./assignWeb2"
import { assignXM } from "./assignXM"
import hashGCRTables from "./hashGCR"
import native from "./manageNative"
import IdentityManager from "./identityManager"
const gcrRoutines = {
    assignWeb2: assignWeb2,
    assignXM: assignXM,
    native: native,
    hashGCRTables: hashGCRTables,
    identityManager: IdentityManager,
}

export default gcrRoutines
