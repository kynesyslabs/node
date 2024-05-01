import { cipher } from "node-forge"

import FHE from "./FHE"

async function main() {

    // Create a new instance of FHE
    // NOTE The resulting instance will be used to perform operations on the encrypted data
    // Only this specific instance will be able to decrypt the data it encrypted
    const fhe = await FHE.getInstance()
    await fhe.config.setParameters()
    await fhe.config.createKeysAndEncoders()

    console.log("[+] FHE instance created")
    console.log("\n\n[ Math Operations ]")
    // Create data to be encrypted
    let plainData = 7
    let addStep = 5
    let multiplyStep = 3
    // Encrypt the PlainText
    var cipheredData = await fhe.encryption.encryptNumber(plainData)

    console.log("\n[Addition]")
    var cipheredAddStep = await fhe.encryption.encryptNumber(addStep)
    // Add the CipherText to itself and store it in the destination parameter (itself)
    var cipheredAdditionResult = await fhe.math.addNumbers(cipheredData, cipheredAddStep)
    // Decrypt the CipherText
    var decryptedAdditionResult = await fhe.encryption.decryptNumber(cipheredAdditionResult)
    console.log("plainData: ", plainData, "\naddStep: ", addStep, "\ndecryptedAdditionResult: ", decryptedAdditionResult)

    var decryptedData = await fhe.encryption.decryptNumber(cipheredData)

    if (decryptedData !== decryptedAdditionResult) {
        console.log("\n[ERROR] The decryptedData is not equal to decryptedAdditionResult")
        process.exit(-1)
    }
    console.log("\n[OK] Now the cipheredData is equal to decryptedAdditionResult: ", decryptedData)
    console.log("\n[Multiplication]")
    var cipheredMultiplyStep = await fhe.encryption.encryptNumber(multiplyStep)
    // Multiply the CipherText to itself and store it in the destination parameter (itself)
    var cipheredMultiplicationResult = await fhe.math.multiplyNumbers(cipheredData, cipheredMultiplyStep)
    // Decrypt the CipherText
    var decryptedMultiplicationResult = await fhe.encryption.decryptNumber(cipheredMultiplicationResult)
    console.log("plainData: ", plainData, "\nmultiplyStep: ", multiplyStep, "\ndecryptedMultiplyResult: ", decryptedMultiplicationResult)

    decryptedData = await fhe.encryption.decryptNumber(cipheredData)
    if (decryptedData !== decryptedMultiplicationResult) {
        console.log("\n[ERROR] The decryptedData is not equal to decryptedMultiplicationResult")
        process.exit(-1)
    }
    console.log("\n[OK] Now the cipheredData is equal to decryptedMultiplicationResult: ", decryptedData)

    console.log("\n[Negate - Flipping the sign of the number]")
    // Boolean operations
    // Negate the CipherText and store it in the destination parameter (itself)
    var cipheredNegateResult = await fhe.math.negate(cipheredData)
    // Decrypt the CipherText
    var decryptedNegateResult = await fhe.encryption.decryptNumber(cipheredNegateResult)
    if (decryptedNegateResult !== -decryptedData) {
        console.log("\n[ERROR] The decryptedNegateResult is not equal to -plainData")
        process.exit(-1)
    }
    console.log("\ndecryptedNegateResult: ", decryptedNegateResult)

    decryptedData = await fhe.encryption.decryptNumber(cipheredData)
    if (decryptedData !== decryptedNegateResult) {
        console.log("\n[ERROR] The decryptedData is not equal to -decryptedNegateResult")
        process.exit(-1)
    }

    console.log("\n[OK] Now the cipheredData is equal to -decryptedNegateResult: ", decryptedData)

    
}


main()