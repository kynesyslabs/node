# Demos Network Key Derivation Specification

**Version**: 1.0.0
**Date**: 2026-01-17
**Status**: Final (Production)

## Abstract

This document specifies the key derivation process used by the Demos Network to convert a BIP39 mnemonic into an Ed25519 keypair. This specification is essential for:
- Hardware wallet implementations
- Third-party wallet integrations
- Cross-platform compatibility testing
- Security audits

## Overview

The Demos Network uses a multi-step key derivation process that transforms a 12-word BIP39 mnemonic into an Ed25519 keypair. The process involves SHA3-512 hashing, HKDF key derivation, and a final SHA256 transformation.

### High-Level Flow

```
┌─────────────────┐
│   Mnemonic      │  12 BIP39 words
│   (12 words)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   SHA3-512      │  Hash the mnemonic string
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Hex Encode    │  64 bytes → 128-char hex string (no 0x prefix)
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  ASCII Encode   │  128-char string → 128-byte array (ASCII codes)
│  (TextEncoder)  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│     HKDF        │  Derive 32-byte key using:
│  (SHA-256)      │  - Salt: "master seed"
│                 │  - Info: "ed25519"
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│  Decimal String │  Convert bytes to comma-separated decimals
│  Conversion     │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│    SHA-256      │  Hash the decimal string
│                 │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│   Ed25519       │  Generate keypair from 32-byte seed
│   Keypair Gen   │
└─────────────────┘
```

## Detailed Specification

### Step 1: Mnemonic Normalization

**Input**: 12-word BIP39 mnemonic phrase
**Output**: Trimmed string

**Process**:
1. Accept mnemonic as string input
2. Trim leading and trailing whitespace
3. Validate against BIP39 English wordlist (2048 words)

**Example**:
```
Input:  "  abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about  "
Output: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
```

### Step 2: SHA3-512 Hash

**Input**: Normalized mnemonic string (UTF-8 encoded)
**Output**: 64-byte hash (Uint8Array)

**Algorithm**: SHA3-512 (FIPS 202)

**Important**: This is SHA3-512, NOT:
- Keccak-512 (pre-standardization SHA3)
- SHA-512 (SHA-2 family)

**Example**:
```
Input:  "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
Output: 77c9f69156488defa99b21d8704b62b060804c1125fa088bf9495f358fe2242514f31bc4d960e74758b88eb2fd7eff4a84fc7c14df9819b55ec7663d654b48af (hex)
```

### Step 3: Hex Encoding

**Input**: 64-byte SHA3-512 hash
**Output**: 128-character lowercase hexadecimal string (NO `0x` prefix)

**Process**:
1. Convert each byte to 2-character hex representation
2. Use lowercase letters (a-f)
3. Ensure NO `0x` prefix is included

**Example**:
```
Input:  [0x77, 0xc9, 0xf6, 0x91, ...]
Output: "77c9f69156488defa99b21d8704b62b060804c1125fa088bf9495f358fe2242514f31bc4d960e74758b88eb2fd7eff4a84fc7c14df9819b55ec7663d654b48af"
```

### Step 4: ASCII Encoding (Master Seed Creation)

**Input**: 128-character hex string
**Output**: 128-byte Uint8Array (the "master seed")

**Process**: Convert each character of the hex string to its ASCII code.

**Critical Detail**: This is NOT parsing the hex string as binary data. Each hex character becomes one byte representing its ASCII value.

**Example**:
```
Input:  "77c9f6..." (128 chars)
Output: [55, 55, 99, 57, 102, 54, ...] (128 bytes)
        ↑   ↑   ↑   ↑   ↑    ↑
        '7' '7' 'c' '9' 'f'  '6' (ASCII codes)
```

**JavaScript equivalent**:
```javascript
const masterSeed = new TextEncoder().encode(hexString);
```

### Step 5: HKDF Derivation

**Input**: 128-byte master seed
**Output**: 32-byte derived seed

**Algorithm**: HKDF (RFC 5869) with SHA-256

**Parameters**:
| Parameter | Value |
|-----------|-------|
| Hash Function | SHA-256 |
| IKM (Input Key Material) | master seed (128 bytes) |
| Salt | `"master seed"` (UTF-8 encoded, 11 bytes) |
| Info | `"ed25519"` (UTF-8 encoded, 7 bytes) |
| Output Length | 32 bytes |

**Example**:
```
Input:  [55, 55, 99, 57, 102, 54, ...] (128 bytes)
Output: 0715507ffd6a856581ab612104aed8736ccaa8c4a287321bcef1e99fda35003d (hex)
```

### Step 6: Decimal String Conversion

**Input**: 32-byte derived seed
**Output**: Comma-separated decimal string

**Process**: Convert each byte to its decimal value, join with commas.

**Example**:
```
Input:  [7, 21, 80, 127, 253, 106, 133, 101, ...] (32 bytes)
Output: "7,21,80,127,253,106,133,101,129,171,97,33,4,174,216,115,108,202,168,196,162,135,50,27,206,241,233,159,218,53,0,61"
```

**JavaScript equivalent**:
```javascript
const decimalString = derivedSeed.toString();
// Uint8Array.prototype.toString() produces comma-separated decimals
```

### Step 7: Final SHA-256 Hash

**Input**: Decimal string from Step 6
**Output**: 32-byte Ed25519 seed

**Algorithm**: SHA-256

**Example**:
```
Input:  "7,21,80,127,253,106,133,101,..."
Output: 9c059a934eed1a4244dc564888d780e60a3b55bc20b67603ddf8633d9ac72959 (hex)
```

### Step 8: Ed25519 Keypair Generation

**Input**: 32-byte Ed25519 seed
**Output**: Ed25519 keypair (32-byte public key, 64-byte private key)

**Algorithm**: Ed25519 (RFC 8032)

**Example**:
```
Input:  9c059a934eed1a4244dc564888d780e60a3b55bc20b67603ddf8633d9ac72959 (hex)
Output:
  Public Key:  263af3be8487729727d99b35dcfdc61bf920a9164249ad117b292e6d3c7194f8
  Private Key: 9c059a934eed1a4244dc564888d780e6... (64 bytes)
```

## Address Derivation

The Demos Network address is simply the public key with a `0x` prefix.

```
Address = "0x" + hex(publicKey)
```

**Example**:
```
Public Key: 263af3be8487729727d99b35dcfdc61bf920a9164249ad117b292e6d3c7194f8
Address:    0x263af3be8487729727d99b35dcfdc61bf920a9164249ad117b292e6d3c7194f8
```

**Note**: The address is NOT derived from hashing the public key (unlike some other blockchain networks).

## Complete Test Vector

### Input
```
Mnemonic: "abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about"
Message:  "Hello, Demos Hardware Wallet!"
```

### Intermediate Values
```
Step 2 - SHA3-512 Hash:
  77c9f69156488defa99b21d8704b62b060804c1125fa088bf9495f358fe2242514f31bc4d960e74758b88eb2fd7eff4a84fc7c14df9819b55ec7663d654b48af

Step 4 - Master Seed:
  Length: 128 bytes
  First 10 bytes: [55, 55, 99, 57, 102, 54, 57, 49, 53, 54]

Step 5 - HKDF Derived Seed:
  0715507ffd6a856581ab612104aed8736ccaa8c4a287321bcef1e99fda35003d

Step 6 - Decimal String:
  "7,21,80,127,253,106,133,101,129,171,97,33,4,174,216,115,108,202,168,196,162,135,50,27,206,241,233,159,218,53,0,61"

Step 7 - Ed25519 Seed:
  9c059a934eed1a4244dc564888d780e60a3b55bc20b67603ddf8633d9ac72959
```

### Expected Outputs
```
Public Key:
  263af3be8487729727d99b35dcfdc61bf920a9164249ad117b292e6d3c7194f8

Address:
  0x263af3be8487729727d99b35dcfdc61bf920a9164249ad117b292e6d3c7194f8

Signature (of message):
  8ab34f7d52a08c78ea2b62a5cb6c973169c00ae5302f7a47ae45d8f3f2260244c933528d5c2aa3cbacf41e37b14d3729f06efc5ae1b9a84e368a0cb5b79adf01
```

## Implementation Notes

### Required Cryptographic Primitives

1. **SHA3-512**: FIPS 202 compliant implementation
2. **SHA-256**: FIPS 180-4 compliant implementation
3. **HKDF**: RFC 5869 compliant implementation
4. **Ed25519**: RFC 8032 compliant implementation

### Common Implementation Pitfalls

1. **Using wrong SHA3 variant**: Must be SHA3-512, not Keccak-512
2. **Including 0x prefix in hex string**: The hex string must NOT have a 0x prefix
3. **Parsing hex as binary**: Step 4 encodes characters as ASCII, not as binary hex values
4. **Wrong HKDF parameters**: Salt and Info must be exact strings specified
5. **Wrong string conversion**: Must use comma-separated decimals, not other formats

### Language-Specific Implementations

#### JavaScript/TypeScript
```javascript
import { sha3_512 } from "@noble/hashes/sha3";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";
import forge from "node-forge";

function deriveKeypair(mnemonic) {
  // Step 2: SHA3-512
  const hash = sha3_512(mnemonic);

  // Step 3: Hex encode (no 0x prefix)
  const hexString = Array.from(hash).map(b => b.toString(16).padStart(2, '0')).join('');

  // Step 4: ASCII encode
  const masterSeed = new TextEncoder().encode(hexString);

  // Step 5: HKDF
  const derivedSeed = hkdf(sha256, masterSeed, "master seed", "ed25519", 32);

  // Step 6-7: Decimal string + SHA256
  const decimalString = derivedSeed.toString();
  const md = forge.sha256.create();
  md.update(decimalString);
  const ed25519Seed = md.digest().toHex();

  // Step 8: Generate keypair
  return forge.pki.ed25519.generateKeyPair({
    seed: Buffer.from(ed25519Seed, "hex")
  });
}
```

#### C/C++ (Arduino/ESP32)
```cpp
// Pseudocode - see demos-hw-wallet implementation for details
void deriveKeypair(const char* mnemonic, uint8_t* publicKey, uint8_t* privateKey) {
  uint8_t sha3Hash[64];
  char hexString[129];
  uint8_t masterSeed[128];
  uint8_t derivedSeed[32];
  char decimalString[256];
  uint8_t ed25519Seed[32];

  // Step 2: SHA3-512
  sha3_512(mnemonic, strlen(mnemonic), sha3Hash);

  // Step 3: Hex encode
  bytesToHex(sha3Hash, 64, hexString);  // No 0x prefix!

  // Step 4: ASCII encode
  for (int i = 0; i < 128; i++) {
    masterSeed[i] = (uint8_t)hexString[i];
  }

  // Step 5: HKDF
  hkdf_sha256(derivedSeed, 32, masterSeed, 128, "master seed", "ed25519");

  // Step 6: Decimal string
  bytesToDecimalString(derivedSeed, 32, decimalString);

  // Step 7: SHA256
  sha256(decimalString, strlen(decimalString), ed25519Seed);

  // Step 8: Ed25519 keypair
  ed25519_create_keypair(publicKey, privateKey, ed25519Seed);
}
```

## Security Considerations

1. **Mnemonic Protection**: The mnemonic must be kept secret and secure
2. **Memory Clearing**: Clear all intermediate values from memory after use
3. **Timing Attacks**: Use constant-time comparison for cryptographic operations
4. **Side Channels**: Be aware of side-channel attack vectors in embedded implementations

## Historical Context

The current derivation process differs from standard BIP32/BIP44 due to a legacy decision that was preserved for backward compatibility with existing testnet wallets. The comment in the SDK source code explains:

> "NOTE: Reverted this bug to keep generating the same keypair with the same mnemonic for mnemonics added to testnet during the incentives campaign."

## References

- [FIPS 202 - SHA-3 Standard](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.202.pdf)
- [FIPS 180-4 - SHA-2 Standard](https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf)
- [RFC 5869 - HKDF](https://tools.ietf.org/html/rfc5869)
- [RFC 8032 - Ed25519](https://tools.ietf.org/html/rfc8032)
- [BIP39 - Mnemonic code](https://github.com/bitcoin/bips/blob/master/bip-0039.mediawiki)

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-01-17 | Initial specification |
