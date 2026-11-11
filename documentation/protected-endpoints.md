## Protected Endpoints

All protected endpoints require transmissions to be coming from the genesis sudo keypair, signed in the body-bound auth form: the signature covers the network's genesis hash, the timestamp, the SHA-256 of the exact request body and the public key of the node called (the `audience` header), so another node refuses it. Each signed request is accepted once. Its memory of seen requests starts empty, so a node refuses requests dated before it started or within five seconds after, and requests dated more than five seconds ahead of its clock. If its clock is set back after it starts, it refuses sudo calls until the clock passes the start again. Sign again if a call lands right after a restart. Call each node separately. A request in the older `identity:timestamp` form (what SDK `demos.call` sends) is refused with 401, since its headers could carry another body.

Use the operator script, which signs that form. It refuses plain `http://` to a remote node, where an observer reads the call and its answer; set `SUDO_CALL_ALLOW_HTTP=1` for a network path you trust.

```sh
SUDO_MNEMONIC="authorized mnemonic here" bun scripts/sudo-call.ts \
    --rpc https://demosnode.discus.sh --method getCampaignData
```

The `params` of each call below go in `--params` as JSON. The SDK snippets show the payload shapes only.

### Unblocking an IP address

Unblocks all the IP addresses supplied to this endpoint.

```ts
const result = await demos.call("rate-limit/unblock", [
    "127.0.0.1",
    // IP addresses here
])
console.log(result)
```

### Get campaign data

Returns data related to the incentives campaign. eg. points and their distribution

```ts
const result = await demos.call("getCampaignData", null)
console.log(result)
```

### Award points

The method call awards points to the accounts with the supplied list of twitter usernames. Only the first account to connect a twitter account is awarded points.

```ts
interface Response {
    success: boolean
    message: string
    error?: string
    txhash?: string
    confirmationBlock: number
}

const result = (await demos.call("awardPoints", [
    // Web2
    {
        username: "cwilvxi",
        points: 1,
        platform: "twitter",
    },
    {
        username: "@Randomblocker",
        points: 20,
        platform: "telegram",
    },

    // Web3
    {
        address: "2FnDmdaoXBzfx7CM4tLCjt9jexnDwysjHz49QkBYV1E2",
        points: 100,
        chain: "solana.mainnet",
    },
    {
        address: "0x21f74bb7dde14b2d5da36df2d57aaa891e3a0039",
        points: 100,
        chain: "eth.mainnet",
    },

    // Native
    {
        address:
            "0x51322c62dcefdcc19a6f2a556a015c23ecb0ffeeb8b13c47e7422974616ff4ab",
        points: 100,
    },
])) as Response

console.log(result)
```
