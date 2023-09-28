import sha256 from "./demos_libs/utils/sha256"

let utils = {
// INFO MUID generator
    generateMuid: function () {

        let array = new Uint32Array(2)
        // eslint-disable-next-line no-undef
        window.crypto.getRandomValues(array)
    
        let number_1 = array[0].toString(36).substring(2, 15)
        let number_2 = array[1].toString(36).substring(2, 15)
    
        let combined = number_1 + number_2
    
        // Use a hash function to generate a unique number from the combined string
        return sha256(combined)
    },
}

exports.utils = utils