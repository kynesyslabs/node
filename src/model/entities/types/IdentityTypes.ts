// export type ProviderIdentities = Map<string, string[]> // NOTE The key is the provider name and the value is an array of public identifiers
// export type ProviderIdentities =

import { PqcIdentityAssignPayload } from "@kynesyslabs/demosdk/abstraction"
import { Web2GCRData } from "@kynesyslabs/demosdk/types"

// export type Context = "xm" | "web2"

export type StoredIdentities = {
    // [key in Context]: ProviderIdentities
    xm: {
        [key: string]: {
            [key: string]: string[]
        }
    }
    web2: {
        [key: string]: Web2GCRData["data"][]
    }
    pqc: {
        [key: string]: {
            address: string
            signature: string
        }[]
        // A mapping of the algorithm identifier a list of the signature and address objects
        // eg. falcon: [{address: "pubkey1", signature: "signature1"}, {address: "pubkey2", signature: "signature2"}]
    }
}

// Example: { xm: { "provider1": ["public_identifier1", "public_identifier2"], "provider2": ["public_identifier3"] }, web2: { "provider1": ["public_identifier4"], "provider2": ["public_identifier5", "public_identifier6"] } }
