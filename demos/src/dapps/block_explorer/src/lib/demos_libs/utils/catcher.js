/* eslint-disable no-unused-vars */

/** 
 * @description A quicker and more elegant way of catching exceptions while running functions 
 *              without crashing, supporting a callback function too
 * @author TheCookingSenpai
 * @param {function} statement
 * @param {function?} callback
 * @returns {[boolean, any]}
 */

function catcher(statement, callback=null) {
	let result = [true, "success"]
	if (typeof statement != 'function') {
		return [false, "statement is not a function"]
	} else {
		// Executing the statement with a try catch to avoid exceptions that causes crashes
		try {
			let stat_result = statement()
			result[1] = stat_result
			return result
		} catch (e) {
			// Supporting a callback function too
			if (callback) {
                result = callback(e)
            } else {
				result = e.message
			}
			return [false, result]
        }
	}
}
export default catcher