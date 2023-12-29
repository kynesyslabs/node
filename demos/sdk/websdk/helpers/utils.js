import sha256 from './demos_libs/utils/sha256'

const utils = {
// INFO MUID generator
  generateMuid: function () {
    const array = new Uint32Array(2)
    // eslint-disable-next-line no-undef
    window.crypto.getRandomValues(array)

    const number_1 = array[0].toString(36).substring(2, 15)
    const number_2 = array[1].toString(36).substring(2, 15)

    const combined = number_1 + number_2

    // Use a hash function to generate a unique number from the combined string
    return sha256(combined)
  }
}

exports.utils = utils
