/**
 * INFO Small module to quickly implement a require-like method as seen in Solidity
 * NOTE Either causes an exception or returns false if the requirement is not met.
 *
 * @author TheCookingSenpai
 * @date 2/9/2023 - 04:15:18
 *
 * @param {any} value
 * @param {boolean} is_fatal
 * @returns {void | boolean}
 */
function required (value, is_fatal = true) {
  if (!value) {
    if (is_fatal) {
      throw new Error('Value of ' + value + ' is required and failed')
    } else {
      return false
    }
  }
  // Requirements are met
  return true
}

export default required
