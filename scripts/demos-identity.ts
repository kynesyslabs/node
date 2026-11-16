import { Demos } from "@kynesyslabs/demosdk/websdk"

export async function newDemosIdentity(): Promise<{ mnemonic: string; address: string }> {
    const demos = new Demos()
    const mnemonic = demos.newMnemonic(128)
    await demos.connectWallet(mnemonic)
    return { mnemonic, address: demos.getAddress() }
}
