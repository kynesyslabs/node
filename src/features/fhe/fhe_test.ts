import { cipher } from "node-forge"

import FHE from "./FHE"
import log from "@/utilities/logger"

async function main() {

    // Create a new instance of FHE
    // NOTE The resulting instance will be used to perform operations on the encrypted data
    // Only this specific instance will be able to decrypt the data it encrypted
    const fhe = await FHE.getInstance()
    await fhe.config.setParameters()
    await fhe.config.createKeysAndEncoders()

    log.info("[+] FHE instance created")
    log.info("\n\n[ Math Operations ]")
    // Create data to be encrypted
    const plainData = 7
    const addStep = 5
    const multiplyStep = 3
    // Encrypt the PlainText
    const cipheredData = await fhe.encryption.encryptNumber(plainData)

    log.info("\n[Addition]")
    const cipheredAddStep = await fhe.encryption.encryptNumber(addStep)
    // Add the CipherText to itself and store it in the destination parameter (itself)
    const cipheredAdditionResult = await fhe.math.addNumbers(cipheredData, cipheredAddStep)
    // Decrypt the CipherText
    const decryptedAdditionResult = await fhe.encryption.decryptNumber(cipheredAdditionResult)
    log.info("plainData: ", plainData, "\naddStep: ", addStep, "\ndecryptedAdditionResult: ", decryptedAdditionResult)

    let decryptedData = await fhe.encryption.decryptNumber(cipheredData)

    if (decryptedData !== decryptedAdditionResult) {
        log.error("\n[ERROR] The decryptedData is not equal to decryptedAdditionResult")
        process.exit(-1)
    }
    log.info("\n[OK] Now the cipheredData is equal to decryptedAdditionResult: ", decryptedData)
    log.info("\n[Multiplication]")
    const cipheredMultiplyStep = await fhe.encryption.encryptNumber(multiplyStep)
    // Multiply the CipherText to itself and store it in the destination parameter (itself)
    const cipheredMultiplicationResult = await fhe.math.multiplyNumbers(cipheredData, cipheredMultiplyStep)
    // Decrypt the CipherText
    const decryptedMultiplicationResult = await fhe.encryption.decryptNumber(cipheredMultiplicationResult)
    log.info("plainData: ", plainData, "\nmultiplyStep: ", multiplyStep, "\ndecryptedMultiplyResult: ", decryptedMultiplicationResult)

    decryptedData = await fhe.encryption.decryptNumber(cipheredData)
    if (decryptedData !== decryptedMultiplicationResult) {
        log.error("\n[ERROR] The decryptedData is not equal to decryptedMultiplicationResult")
        process.exit(-1)
    }
    log.info("\n[OK] Now the cipheredData is equal to decryptedMultiplicationResult: ", decryptedData)

    log.info("\n[Negate - Flipping the sign of the number]")
    // Boolean operations
    // Negate the CipherText and store it in the destination parameter (itself)
    const cipheredNegateResult = await fhe.math.negate(cipheredData)
    // Decrypt the CipherText
    const decryptedNegateResult = await fhe.encryption.decryptNumber(cipheredNegateResult)
    if (decryptedNegateResult !== -decryptedData) {
        log.error("\n[ERROR] The decryptedNegateResult is not equal to -plainData")
        process.exit(-1)
    }
    log.info("\ndecryptedNegateResult: ", decryptedNegateResult)

    decryptedData = await fhe.encryption.decryptNumber(cipheredData)
    if (decryptedData !== decryptedNegateResult) {
        log.error("\n[ERROR] The decryptedData is not equal to -decryptedNegateResult")
        process.exit(-1)
    }

    log.info("\n[OK] Now the cipheredData is equal to -decryptedNegateResult: ", decryptedData)

    
}


main()