import { Letter, encryptedLetter, MessageContent, InstantMessagingSession } from "./types/instantMessaging"

export default class InstantMessaging {
    private static instances: Map<string, InstantMessagingSession> = new Map()

    static async parseMessage(message: any): Promise<InstantMessagingSession> {
        // TODO Parsing the MessageContent and do stuff
        let identifier_string = "" // This will be used to identify the session
        let session = InstantMessaging.instances.get(identifier_string)
        if (!session) {
            session = new InstantMessagingSession(identifier_string)
            InstantMessaging.instances.set(identifier_string, session)
        }
        return session
    }

}