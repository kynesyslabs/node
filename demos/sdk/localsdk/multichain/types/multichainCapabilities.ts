import * as multichain from "sdk/localsdk/multichain"

export default async function multichainCapabilities() {
    return Object.keys(multichain)
}