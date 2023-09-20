import forge from "node-forge"
import { Buffer } from "buffer/"


/**
 * Description placeholder
 * @date 6/9/2023 - 19:38:01
 *
 * @param {forge.pki.ed25519.BinaryBuffer} forgeBuffer
 * @returns {Buffer}
 */
function forgeToString(forgeBuffer) {
	console.log("[forge to string]")
	let derived = JSON.stringify(forgeBuffer)
	console.log(derived)
	return derived
}

function forgeToHexString(forgeBuffer) {
	console.log("[forge to hex string]")
    let derived = JSON.stringify(forgeBuffer)
	derived = Buffer.from(forgeBuffer).toString("hex")
    console.log(derived)
    return derived
}

function hexStringToForge(forgeString) {
	console.log("[hex string to forge]")
	let derived = Buffer.from(forgeString).toString("utf8") // REVIEW
	derived = JSON.parse(forgeString)
    console.log(derived)
    return derived
}

/**
 * Description placeholder
 * @date 6/9/2023 - 19:38:29
 *
 * @param {string} forgeString
 * @returns {Buffer}
 */
function stringToForge(forgeString) {
	console.log("[string to forge]")
	let derived = JSON.parse(forgeString)
	console.log(derived)
	return derived
}

export { forgeToString, forgeToHexString, stringToForge, hexStringToForge}