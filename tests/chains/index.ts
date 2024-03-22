describe("GENERIC CHAIN TESTS", () => {
    test("Hi", () => {
        expect(1).toBe(1)
    })

    test.todo("Chain has a valid name")
    test.todo("Chain connects to the RPC")
    test.todo("On connect failure, .connected is false")
    test.todo("On disconnect, provider is reset")
})