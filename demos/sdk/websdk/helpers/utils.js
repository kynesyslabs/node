
let utils = {
// INFO MUID generator
    generateMuid: function () {
        let number_1 =
		Math.random().toString(36).substring(2, 15) +
		Math.random().toString(36).substring(2, 15)
        let number_2 =
		Math.random().toString(36).substring(2, 15) +
		Math.random().toString(36).substring(2, 15)
        let muid = number_1 + number_2
        return muid
    },
}

exports.utils = utils