## Protected Endpoints

All protected endpoints require transmissions to be coming from a sudo keypair.

### Unblocking an IP address

```ts
const demos = new Demos()

await demos.connect("https://demosnode.discus.sh")
await demos.connectWallet("authorized mnemonic here")

const result = await demos.call("rate-limit/unblock", [
    "127.0.0.1",
])
console.log(result)
```

### Get campaign data

```ts
const demos = new Demos()

await demos.connect("https://demosnode.discus.sh")
await demos.connectWallet("authorized mnemonic here")

const result = await demos.call("getCampaignData", null)
console.log(result)
```