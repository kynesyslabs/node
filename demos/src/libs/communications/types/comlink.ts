/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import Transmission from "../transmission"

export interface Current {
    currentMessage: Transmission
    currentMessageHash: string
    previousHashes: string[]
}

export interface Properties {
    connection_string: string
    require_reply: boolean
    is_reply: boolean
}
