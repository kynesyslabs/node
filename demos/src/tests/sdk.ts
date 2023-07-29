import Demos from "sdk/demos"

// ANCHOR Ingesting arguments
let args: any[] = []
process.argv.forEach(function (val, index, array) {
    if (index > 1) { args.push(val) }
})

// NOTE Getting the last block number
async function getblocknumber() {
    let demos = new Demos()
    await demos.connect("http", "localhost", 53550) // Will throw an error if not connected
    demos.getLastBlockNumber()
}

// INFO Entry point
if (args.length > 0) {
    if (args[0] === "getblocknumber") {
        getblocknumber()
    }
}

