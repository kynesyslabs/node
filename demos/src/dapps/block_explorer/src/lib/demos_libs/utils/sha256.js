/**
 * Hashes any string using crypto subtle
 * @date 2/9/2023 - 04:48:06
 *
 * @async
 * @param {*} string
 * @returns {string}
 */
async function sha256 (string) {
  const utf8 = new TextEncoder().encode(string)
  const hashBuffer = await crypto.subtle.digest('SHA-256', utf8)
  const hashArray = Array.from(new Uint8Array(hashBuffer)) // FIXME Review if it's to change to buffer here
  // sourcery skip: inline-immediately-returned-variable
  const hashHex = hashArray
    .map((bytes) => bytes.toString(16).padStart(2, '0'))
    .join('')
  return hashHex
}

export default sha256
