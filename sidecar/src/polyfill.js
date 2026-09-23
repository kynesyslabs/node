// Promise.withResolvers landed in Node 22; libp2p 2.x uses it internally.
// Polyfill so the sidecar also runs on Node 20 LTS. Must be the first
// import of the entrypoint so it executes before any libp2p module.
if (typeof Promise.withResolvers !== "function") {
    Promise.withResolvers = function withResolvers() {
        let resolve, reject
        const promise = new Promise((res, rej) => {
            resolve = res
            reject = rej
        })
        return { promise, resolve, reject }
    }
}
