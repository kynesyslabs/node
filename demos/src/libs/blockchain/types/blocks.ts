import Transactions from "../transaction"

export default interface BlockContent {
    transactions: Transactions[]
    web2data: {} // TODO Add Web2 class
    previousHash: string
}
