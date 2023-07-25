import * as fs from "fs"

export default async function commandLine(): Promise<any> {
    console.log("This node is in testing mode")
    console.log("It will now run a test suite on the test server (as defined in ./test_server)")
    let test_server = await fs.readFileSync("src/test_server")
    console.log("Test server: \n" + test_server)
    // Get input from user
    let breaker = false
    while (!breaker) {
        let input = "end"
        // TODO Getting input from user
        switch (input.toLowerCase()) {
            // TODO Write commands
            case "end":
                breaker = true
                break
            default:
                break
        }
    }
    process.exit(0)
}
