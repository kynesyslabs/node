## Protected Endpoints

All protected endpoints require transmissions to be coming from a sudo keypair. Connect an authorized mnemonic as shown before proceeding:

```ts
const demos = new Demos()

await demos.connect("https://demosnode.discus.sh")
await demos.connectWallet("authorized mnemonic here")
```

### Unblocking an IP address

```ts
const result = await demos.call("rate-limit/unblock", [
    "127.0.0.1",
])
console.log(result)
```

### Get campaign data

```ts
const result = await demos.call("getCampaignData", null)
console.log(result)
```

### Award points

Awards points to accounts based on Twitter usernames.

```ts
const result = await demos.call("awardPoints", ["username1", "username2"])
console.log(result)
```