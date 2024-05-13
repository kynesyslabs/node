import Chain from "src/libs/blockchain/chain"


export default async function getAddressInfo(address: string) {
    return await Chain.getAddressInfo(address)
}