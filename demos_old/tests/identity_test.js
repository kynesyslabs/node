let identity = require("../libs/identity")
let fs = require("fs")

async function main() {
    console.log("Generating random keys")
    let keypair = await identity.cryptography.new()
    console.log(keypair)
    identity.cryptography.save(keypair, "identity_test_file.txt")
    console.log("Loading saved keys")
    let derived = identity.cryptography.load("identity_test_file.txt")
    console.log(derived)
    if (derived == keypair) {
        console.log("[OK] They match")
    } else {
        console.log("[ERROR] They mismatch")
    }
}

main()
