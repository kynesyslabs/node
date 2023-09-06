import forge from "node-forge"
import { Buffer } from "buffer/"


/**
 * Description placeholder
 * @date 6/9/2023 - 19:38:01
 *
 * @param {forge.pki.ed25519.BinaryBuffer} forgeBuffer
 */
function forgeToString(forgeBuffer) {
	console.log("[forge to string]")
	console.log(forgeBuffer)
	return forgeBuffer.toString("hex")
}


/**
 * Description placeholder
 * @date 6/9/2023 - 19:38:29
 *
 * @param {string} forgeString
 */
function stringToForge(forgeString) {
	console.log("[string to forge]")
    console.log(forgeString)
	return Buffer.from(forgeString, "hex")
}

export { forgeToString, stringToForge }