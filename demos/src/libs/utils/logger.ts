/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import { terminal } from "terminal-kit"

export default class logger {
    static log(message: string): void {
        terminal("[INFO]")
        terminal(message)
        terminal("\n")
    }

    static bootstrap(message: string): void {
        terminal.bold(message)
    }

    static bootstrapSuccess(message: string): void {
        terminal.green.bold(message)
    }

    static warn(message: string): void {
        terminal("[WARN]")
        terminal(message)
        terminal("\n")
    }

    static error(message: string): void {
        terminal("[ERROR]")
        terminal(message)
        terminal("\n")
    }

    static critical(message: string): void {
        terminal("[CRITICAL]")
        terminal(message)
        terminal("\n")
    }
}
