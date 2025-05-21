// export type ProviderIdentities = Map<string, string[]> // NOTE The key is the provider name and the value is an array of public identifiers
// export type ProviderIdentities = 

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
    },
    pqc: {
        [key: string]: string[]
        // eg. falcon: ["pubkey1", "pubkey2"]
    }
}

// Example: { xm: { "provider1": ["public_identifier1", "public_identifier2"], "provider2": ["public_identifier3"] }, web2: { "provider1": ["public_identifier4"], "provider2": ["public_identifier5", "public_identifier6"] } }

