import Demos from "sdk/demos"

async function testSDK() {
    let demos = new Demos()
    await demos.connect("http", "localhost", 53550) // Will throw an error if not connected
    demos.getLastBlockNumber()
    // FIXME Why the server keeps trying to sync with a non identity based client? (see onAny above)
}

testSDK()