import { Context } from "node-seal/implementation/context"
import SEAL from "node-seal"
import { EncryptionParameters } from "node-seal/implementation/encryption-parameters"
import { SEALLibrary } from "node-seal/implementation/seal"
import { KeyGenerator } from "node-seal/implementation/key-generator"
import { PublicKey } from "node-seal/implementation/public-key"
import { SecretKey } from "node-seal/implementation/secret-key"
import { BatchEncoder } from "node-seal/implementation/batch-encoder"
import { Encryptor } from "node-seal/implementation/encryptor"
import { Decryptor } from "node-seal/implementation/decryptor"
import { Evaluator } from "node-seal/implementation/evaluator"

export default class FHE {
    public static instance: FHE

    // Properties
    private initialized: boolean = false
    public seal: SEALLibrary = null
    public schemeType: any
    public securityLevel: any
    public polyModulusDegree: number
    public bitSizes: number[]
    public bitSize: number
    public parms: EncryptionParameters
    public context: Context


    public keyGenerator: KeyGenerator
    public publicKey: PublicKey
    public secretKey: SecretKey
    public encoder: BatchEncoder
    public encryptor: Encryptor
    public decryptor: Decryptor
    public evaluator: Evaluator

    constructor() {}

    public static async getInstance(): Promise<FHE> {
        if (!FHE.instance) {
            FHE.instance = new FHE()
            await FHE.instance.initialize()
        }

        return FHE.instance
    }

    // NOTE Basic initialization
    private async initialize(): Promise<void> {
        if (this.initialized) {
            return
        }
        // Initializing SEAL
        this.seal = await SEAL()
        this.schemeType = this.seal.SchemeType.bfv
        this.securityLevel = this.seal.SecurityLevel.tc128
        this.polyModulusDegree = 4096
        this.bitSizes = [36, 36, 37]
        this.bitSize = 20
        this.parms = this.seal.EncryptionParameters(this.schemeType)
    }

    // NOTE Set the parameters and create the context
    public async setParameters(): Promise<void> {
        // Set the PolyModulusDegree
        this.parms.setPolyModulusDegree(this.polyModulusDegree)

        // Create a suitable set of CoeffModulus primes
        this.parms.setCoeffModulus(
            this.seal.CoeffModulus.Create(
                this.polyModulusDegree,
                Int32Array.from(this.bitSizes),
            ),
        )

        // Set the PlainModulus to a prime of bitSize 20.
        this.parms.setPlainModulus(
            this.seal.PlainModulus.Batching(
                this.polyModulusDegree,
                this.bitSize,
            ),
        )

        // Create the context
        this.context = this.seal.Context(
            this.parms, // Encryption Parameters
            true, // ExpandModChain
            this.securityLevel, // Enforce a security level
        )

        if (!this.context.parametersSet()) {
            throw new Error(
                "Could not set the parameters in the given context. Please try different encryption parameters.",
            )
        }
    }

    // NOTE Create the keys and the encoders
    public async createKeysAndEncoders(): Promise<void> {
        // Create the keys
        this.keyGenerator = this.seal.KeyGenerator(this.context)
        this.publicKey = this.keyGenerator.createPublicKey()
        this.secretKey = this.keyGenerator.secretKey()
        this.encoder = this.seal.BatchEncoder(this.context)
        this.encryptor = this.seal.Encryptor(this.context, this.publicKey)
        this.decryptor = this.seal.Decryptor(this.context, this.secretKey)
        this.evaluator = this.seal.Evaluator(this.context)
    }

    // NOTE Encrypt a number
    public async encryptNumber(num: number): Promise<any> {
        // Encode the Array
        const plainText = this.encoder.encode(Int32Array.from([num]))

        // Encrypt the PlainText
        const cipherText = this.encryptor.encrypt(plainText)

        return cipherText
    }

    // NOTE Decrypt a number
    public async decryptNumber(cipherText: any): Promise<number> {
        // Decrypt the CipherText
        const decryptedPlainText = this.decryptor.decrypt(cipherText)

        // Decode the PlainText
        const decodedArray = this.encoder.decode(decryptedPlainText)

        return decodedArray[0]
    }

    // NOTE Add two numbers
    public async addNumbers(
        cipherText1: any,
        cipherText2: any,
    ): Promise<any> {
        // Add the CipherText to itself and store it in the destination parameter (itself)
        this.evaluator.add(cipherText1, cipherText2, cipherText1) // Op (A), Op (B), Op (Dest)

        return cipherText1
    }

    // NOTE Multiply two numbers
    public async multiplyNumbers(
        cipherText1: any,
        cipherText2: any,
    ): Promise<any> {
        // Multiply the CipherText to itself and store it in the destination parameter (itself)
        this.evaluator.multiply(cipherText1, cipherText2, cipherText1) // Op (A), Op (B), Op (Dest)

        return cipherText1
    }

    // NOTE Boolean operations
    public async negate(
        cipherText1: any,
        cipherText2: any,
    ): Promise<any> {
        let res = this.evaluator.negate(cipherText1, cipherText2) // Op (A), Op (Dest)
        return res
    }

    // NOTE Fallback to plain call
    public async call(
        methodName: string,
        [cipherText1, cipherText2]: any[],
    ) {
        try {
            return await this.evaluator[methodName](cipherText1, cipherText2)
        } catch (error) {
            console.log("[FHE] Error: " + JSON.stringify(error))
            return null
        }
    
    }


}

/*

async function main() {
    const fhe = await FHE.getInstance()
    await fhe.setParameters()
    await fhe.createKeysAndEncoders()

    // Create data to be encrypted
    const array = Int32Array.from([1, 2, 3, 4, 5])

    // Encrypt the PlainText
    var cipherFirstNumber = await fhe.encryptNumber(1)
    var cipherSecondNumber = await fhe.encryptNumber(2)
    // Add the CipherText to itself and store it in the destination parameter (itself)
    var cipherText_added = await fhe.addNumbers(cipherFirstNumber, cipherSecondNumber)
    // Decrypt the CipherText
    var decryptedPlainText = await fhe.decryptNumber(cipherText_added)
    console.log("decryptedPlainText", decryptedPlainText)

    // Encrypt the PlainText for the first number which was modified before
    var cipherFirstNumber = await fhe.encryptNumber(1)
    // Multiply the CipherText to itself and store it in the destination parameter (itself)
    var cipherText_multiplied = await fhe.multiplyNumbers(cipherFirstNumber, cipherSecondNumber)
    // Decrypt the CipherText
    var decryptedPlainText = await fhe.decryptNumber(cipherText_multiplied)
    console.log("decryptedPlainText", decryptedPlainText)
}

main()

*/