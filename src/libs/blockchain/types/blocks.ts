/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Transactions from "../transaction"

export default interface BlockContent {
    ordered_transactions: string[]
    per_address_transactions: Map<string, string[]>
    web2data: {} // TODO Add Web2 class
    previousHash: string
    timestamp: number
}
