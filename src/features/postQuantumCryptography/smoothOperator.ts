import Enigma from "./enigma"

// NOTE A single session using Enigma for E2E message delivery
export class EnigmaSession {
    private name: string
    private enigma: Enigma = new Enigma()

    // SECTION Session properties
    private longTermKeys: any
    private shortTermKey: any

    // INFO Multiton logic
    constructor(name: string) {
        this.name = name
        this.longTermKeys = {
            our: null,
            their: null,
        }
        console.log(
            "Warning: initialize with 'await this.init()' before using this class",
        )
    }

    // INFO Generating a new McEliece keypair that will be our long term one
    async init() {
        await this.enigma.init()
        this.longTermKeys.our = this.enigma.mcelieceKeypair
    }

    // INFO If not yet defined, set the other peer long term public key
    async setTheirKey(key: any) {
        if (!this.longTermKeys.their) {
            this.longTermKeys.their = key
        } else {
            return false
        }
    }

    async newMessage(message: any): Promise<any> {
        this.shortTermKey = await this.enigma.generateSecrets(
            this.longTermKeys.their,
        )
        let encrypted = await this.enigma.encrypt(
            message,
            Buffer.from(this.shortTermKey.privateKey).toString("hex"),
        )
        return encrypted
    }

    async readMessage(message: any, encapsulation: any): Promise<any> {
        this.shortTermKey = await this.enigma.deriveSharedSecret(encapsulation)
        let decrypted = await this.enigma.decrypt(
            message,
            Buffer.from(this.shortTermKey.privateKey).toString("hex"),
        )
        return decrypted
    }

    // INFO Data protection logic
    get = {
        name: function () {
            return this.name
        },
    }
}

// NOTE A manager for EnigmaSessions
export default class smoothOperator {
    private static sessions: Map<string, EnigmaSession> = new Map()

    constructor() {}

    // INFO Multiton logic
    static getSession(session: string = null): EnigmaSession {
        if (session == null) {
            session = smoothOperator.newRandomSessionName()
        }
        if (smoothOperator.sessions.has(session)) {
            return smoothOperator.sessions.get(session)
        } else {
            let newSession = new EnigmaSession(session)
            smoothOperator.sessions.set(session, newSession)
            return newSession
        }
    }

    static newRandomSessionName(): string {
        return Math.random().toString(36).substring(2, 15)
    }
}
