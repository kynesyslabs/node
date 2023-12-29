/**
 * Converting uint8arrays into node.js-like objects representing a Buffer
 * @date 2/9/2023 - 04:47:48
 *
 * @param {*} uint8array
 * @returns {{ type: string; data: {}; }}
 */
function bufferize (uint8array) {
  const buffer = { type: 'Buffer', data: [] }
  for (let i = 0; i < uint8array.length; i++) {
    buffer.data.push(uint8array[i])
  }
  return buffer
}

export default bufferize
