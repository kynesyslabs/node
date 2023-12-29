import forge from 'node-forge'
import { Buffer } from 'buffer/'

function forgeToString (forgeBuffer, isHex = true) {
  if (isHex) return ForgeToHex(forgeBuffer)
  else return forgeToRawString(forgeBuffer)
}

function stringToForge (string, isHex = true) {
  if (isHex) return HexToForge(string)
  else return rawStringToForge(string)
}

/**
 * Description placeholder
 * @date 6/9/2023 - 19:38:01
 *
 * @param {forge.pki.ed25519.BinaryBuffer} forgeBuffer
 * @returns {Buffer}
 */
function forgeToRawString (forgeBuffer) {
  console.log('[forge to string]')
  const derived = JSON.stringify(forgeBuffer)
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
function rawStringToForge (forgeString) {
  console.log('[string to forge]')
  const derived = JSON.parse(forgeString)
  console.log(derived)
  return derived
}

// INFO forgeBuffer comes in as the raw result of forge methods
function ForgeToHex (forgeBuffer) {
  const hex = ''
  console.log('[forge to string encoded]')
  console.log(forgeBuffer)
  const rebuffer = Buffer.from(forgeBuffer)
  forgeBuffer = rebuffer.toString('hex')
  console.log('DECODED INTO:')
  console.log('0x' + forgeBuffer)
  return '0x' + forgeBuffer
}

// INFO finalArray must come out as an acceptable input for forge methods
// NOTE The above and the below must be revertible with each other
function HexToForge (forgeString) {
  forgeString = forgeString.slice(2)
  const finalArray = new Uint8Array(64)
  console.log('[string to forge encoded]')
  console.log(forgeString)
  for (let i = 0; i < forgeString.length; i += 2) {
	  const hexValue = forgeString.substr(i, 2)
	  const decimalValue = parseInt(hexValue, 16)
	  finalArray[i / 2] = decimalValue
  }
  console.log('ENCODED INTO:')
  console.log(finalArray)
  return finalArray
}

export { forgeToString, stringToForge }
