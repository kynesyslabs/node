import { DemoScript } from "@kynesyslabs/demosdk/types"

export default interface GCROperation {
    address: string // Public key of the address
    data: DemoScript // The data that has been executed
    gas: number // The gas used
}
