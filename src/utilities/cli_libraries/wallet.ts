import * as fs from "fs"
// INFO Singleton managing the wallet in a cli environment
import forge from "node-forge"

export interface Identity {
    privateKey: forge.pki.ed25519.BinaryBuffer
    publicKey: forge.pki.ed25519.BinaryBuffer
}

export default class Wallet {
    private static instance: Wallet

    identity: Identity = { privateKey: null, publicKey: null }

    public static getInstance(): Wallet {
        if (!Wallet.instance) {
            Wallet.instance = new Wallet()
        }
        return Wallet.instance
    }

    // NOTE If provided, the seed will be used to generate the keys
    constructor(pk: string = null) {
        if (pk) {
            this.load(pk)
        } else {
            this.create()
        }
    }

    create() {
        this.identity = forge.pki.ed25519.generateKeyPair()
    }

    dispatch(dividedInput: any) {
        // We need the modes (2 to 3 arguments)
        if (dividedInput.length < 2 || dividedInput.length > 3) {
            console.log("Please specify a command")
            return
        }
        const mode = dividedInput[1]
        switch (mode.toLowerCase()) {
            default:
                console.log(
                    "Please specify a valid mode between create and load",
                )
                break
            // NOTE New wallet from scratch
            case "create":
                if (dividedInput.length > 2) {
                    console.log("WARNING: Excess of arguments will be ignored")
                }
                try {
                    this.create()
                    console.log("Wallet created successfully")
                } catch (e) {
                    console.log(e["message"])
                }
                break
            // NOTE Loading from an hex private key
            case "load":
                if (dividedInput.length < 3) {
                    console.log("Please specify a private key in hex format")
                    break
                }
                try {
                    this.load(dividedInput[2])
                    console.log("Wallet loaded successfully")
                } catch (e) {
                    console.log(e["message"])
                }
                break
            // NOTE Saving the wallet to a file
            case "save": // Requires an input from the user or default to a file
                var filename: string
                if (dividedInput.length < 3) {
                    console.log("Using default file name: wallet.demos")
                    filename = "wallet.demos"
                } else {
                    filename = dividedInput[2]
                }
                // Writing to file
                try {
                    this.save(filename)
                    console.log("Wallet saved successfully")
                } catch (e) {
                    console.log(e["message"])
                }
                break
            // NOTE Reading from a file
            case "read": // Requires an input from the user or default to a file
                var loadFilename: string
                if (dividedInput.length < 3) {
                    console.log(
                        "Trying to read from default file name: wallet.demos",
                    )
                    loadFilename = "wallet.demos"
                } else {
                    loadFilename = dividedInput[2]
                }
                // Reading from file
                try {
                    this.read(loadFilename)
                    console.log("Wallet read successfully")
                } catch (e) {
                    console.log(e["message"])
                }
                break
            // NOTE Showing the wallet
            case "show": // Shows the wallet
                //console.log(this.identity)
                break
        }
    }

    load(pk: string) {
        this.identity.privateKey = Buffer.from(pk, "hex")
        this.identity.publicKey = forge.pki.ed25519.publicKeyFromPrivateKey({
            privateKey: this.identity.privateKey,
        })
    }

    save(filename: string) {
        fs.writeFileSync(filename, this.identity.privateKey.toString("hex"))
    }

    read(filename: string) {
        const stringedPk = fs.readFileSync(filename, "utf8")
        this.identity.privateKey = Buffer.from(stringedPk, "hex")
        this.identity.publicKey = forge.pki.ed25519.publicKeyFromPrivateKey({
            privateKey: this.identity.privateKey,
        })
    }
}
