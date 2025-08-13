## Protected Endpoints

All protected endpoints require transmissions to be coming from a sudo keypair. Connect an authorized mnemonic as shown before proceeding:

```ts
const demos = new Demos()

await demos.connect("https://demosnode.discus.sh")
await demos.connectWallet("authorized mnemonic here")
```

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
const result = await demos.call("awardPoints", ["username1", "username2"])
console.log(result)
```

NOTE: This endpoint is configured to award a single point to each account.