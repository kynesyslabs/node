# Native send fee quote: node half of #1165

Native-send confirmation quotes the gross fee (excluding the amount) in `response.data.transaction.attrs.total_fee`, in ledger units (OS after `osDenomination`, DEM before). `attrs.reference_block` is the quote height. For send max, subtract the quote from the balance and confirm the resulting send.

At default fees with `gasFeeSeparation` active, a 100 DEM balance supports a 97 DEM send (3 DEM fee). A 98 DEM send based on the signed 2 DEM distribution fee is refused without charging balance or nonce; the refusal carries the quote. Treasury senders must cover the gross fee even when they receive a share back.

## SDK follow-up

SDK up to 4.0.19 reads `gas_operation.fees ?? content.transaction_fee` for `demos.run.*` `feeDem` and `maxFee`; this node returns `gas_operation: null`.
With `gasFeeSeparation` active, the SDK undercounts the charge by the gas edit (1 DEM at default fees), so a caller can exceed `maxFee`.
With it dormant, the SDK overcounts by the signed distribution fees (shows 2 DEM at default fees, while apply charges 1 DEM), so send max leaves funds behind.
Non-native transactions pay the SDK gas edit plus any debit their own type ships (for example the storage burn); `d402_payment` and `identity` pay no gas. Their shipped distribution fee is not a charge until they get their own quote.
SDK users should read `attrs.total_fee` for display, send max and fee limits. [kynesyslabs/sdks](https://github.com/kynesyslabs/sdks) needs a follow-up before #1165 closes; historical transactions may lack a quote.

Signed `content.transaction_fee` describes distribution fees. The node quotes the SDK gas edit plus those fees only while `gasFeeSeparation` is active. It removes client quotes and signs the validity response. Confirmation compares amount plus fee with balance; apply and fork schedules are unchanged. The dormant `calculateCurrentGas()`/`defineGas()` path does not drive native sends.

Before `nonceIntegrity`, failed sends roll back fee and nonce. After it, `chargeFailure()` charges fee and nonce when affordable, otherwise only nonce. Reconfirm when balances, fees or forks change. No new parameters or migrations are needed; Docker Compose, `./run` and Bun use the existing loader.
