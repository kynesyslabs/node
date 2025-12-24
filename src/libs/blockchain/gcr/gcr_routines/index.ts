import { assignWeb2 } from "./assignWeb2"
import { assignXM } from "./assignXM"
import hashGCRTables from "./hashGCR"
// import native from "./manageNative"
// REVIEW: IPFS routines added in Phase 3 of IPFS integration
import GCRIPFSRoutines from "./GCRIPFSRoutines"

const gcrRoutines = {
    assignWeb2: assignWeb2,
    assignXM: assignXM,
    // native: native,
    hashGCRTables: hashGCRTables,
    ipfs: GCRIPFSRoutines,
}

export default gcrRoutines
