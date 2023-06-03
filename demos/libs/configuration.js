// INFO Simple module to always export as config the configuration file

const fs = require("fs")
const path = require("path")

const dirname = "./"
const config = JSON.parse(fs.readFileSync(path.join(dirname, "config.json"), "utf8"))

module.exports = { config }