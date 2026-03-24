# UD Technical Reference - Networks & Contracts

## Network Configuration

### EVM Networks (Priority Order)

1. **Polygon L2**: `0x0E2846C302E5E05C64d5FaA0365b1C2aE48AD2Ad` | `https://polygon-rpc.com`
2. **Base L2**: `0xF6c1b83977DE3dEffC476f5048A0a84d3375d498` | `https://mainnet.base.org`
3. **Sonic**: `0xDe1DAdcF11a7447C3D093e97FdbD513f488cE3b4` | `https://rpc.soniclabs.com`
4. **Ethereum UNS**: `0x049aba7510f45BA5b64ea9E658E342F904DB358D` | `https://eth.llamarpc.com`
5. **Ethereum CNS**: `0xD1E5b0FF1287aA9f9A268759062E4Ab08b9Dacbe` | `https://eth.llamarpc.com`

### Solana Network

- **UD Program**: `6eLvwb1dwtV5coME517Ki53DojQaRLUctY9qHqAsS9G2`
- **RPC**: `https://api.mainnet-beta.solana.com`
- **Resolution**: Via `udSolanaResolverHelper.ts` (direct Solana program interaction)
- **Integration**: Fallback after all EVM networks fail

## Record Keys Priority

**Signable Records** (support multi-address verification):

- `crypto.ETH.address` - Primary EVM
- `crypto.SOL.address` - Primary Solana
- `crypto.MATIC.address` - Polygon native
- `token.EVM.ETH.ETH.address` - EVM token addresses
- `token.EVM.MATIC.MATIC.address` - Polygon token addresses
- `token.SOL.SOL.SOL.address` - Solana token addresses
- `token.SOL.SOL.USDC.address` - Solana USDC

**Non-Signable** (skip):

- `crypto.BTC.address` - Bitcoin can't sign Demos challenges
- `ipfs.html.value` - Not an address
- `dns.*` - Not an address

## Signature Detection Patterns

### Address Formats

```typescript
// EVM: 0x prefix + 40 hex chars
/^0x[0-9a-fA-F]{40}$/

// Solana: Base58, 32-44 chars
/^[1-9A-HJ-NP-Za-km-z]{32,44}$/
```

### Verification Methods

**EVM**: `ethers.verifyMessage(signedData, signature)` → recoveredAddress
**Solana**: `nacl.sign.detached.verify(messageBytes, signatureBytes, publicKeyBytes)` → boolean

## Test Data Examples

### EVM Domain (sir.crypto on Polygon)

- Owner: `0x45238D633D6a1d18ccde5fFD234958ECeA46eB86`
- Records: Sparse (2/11 populated)
- Signable: 1 EVM address

### Solana Domain (thecookingsenpai.demos)

- Records: Rich (4/11 populated)
- Signable: 2 EVM + 2 Solana addresses
- Multi-chain from start

## Environment Variables

```bash
ETHEREUM_RPC=https://eth.llamarpc.com  # EVM resolution
# Solana resolution via helper - no API key needed
```
