/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import forge, { pki } from "node-forge"

export interface BundleContent {
    type: string
    message: string
    sender: any // TODO improve interface
    receiver: any // TODO improve interface
    timestamp: number
    data: any // NOTE Depends on the actual step
    extra: string
}

export interface Bundle {
    content: BundleContent
    hash: string
    signature: any // TODO improve interface
}
