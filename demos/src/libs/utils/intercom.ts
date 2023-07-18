/* LICENSE

© 2023 by KyneSys Labs, licensed under CC BY-NC-ND 4.0

Full license text: https://creativecommons.org/licenses/by-nc-nd/4.0/legalcode
Human readable license: https://creativecommons.org/licenses/by-nc-nd/4.0/

KyneSys Labs: https://www.kynesys.xyz/

*/

import * as PubSub from "pubsub-js"

export default class Intercom {
    static broadcast(topic: string, data: any): void {
        PubSub.publishSync(topic, data)
    }

    static subscribe(
        topic: string,
        callback: (msg: string, data: any) => void,
    ): string {
        let subscriber: string = PubSub.subscribe(topic, callback)
        return subscriber
    }

    static unsubscribe(subscriber: string): void {
        PubSub.unsubscribe(subscriber)
    }

    static test(): void {
        this.broadcast("new_message", "test")
    }
}
