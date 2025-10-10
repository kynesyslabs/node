# Unstoppable Domains Solana Integration - Exploration Findings

## Session Context
**Date**: 2025-10-10
**Goal**: Understand UD Solana NFT collection structure to enable domain resolution (e.g., `thecookingsenpai.demos` → properties)

## Key Discoveries

### Account Structure Analysis
The UD Solana program (`6eLvwb1dwtV5coME517Ki53DojQaRLUctY9qHqAsS9G2`) contains 13,084 accounts categorized as:

1. **4,253 Domain Records** (121 bytes, discriminator: `692565c54bfb661a`)
   - **IMPORTANT**: All 121-byte accounts contain IDENTICAL data
   - Content: Static strings "domain_properties" and "__event_authority"
   - Counter value: 109 (consistent across all accounts)
   - **Conclusion**: These are NOT storage accounts for domain data, they are template/structure accounts

2. **4,253 State Accounts** (24 bytes, discriminator: `f7606257698974c2`)
   - Minimal data structures
   - Likely indexes or state management

3. **4,563 Reverse Mapping Accounts** (56 bytes, discriminator: `fee975fc4ca6928b`)
   - Format: `[discriminator: 8 bytes][length: 4 bytes][address string: N bytes]`
   - Contains property values (addresses) for reverse lookup
   - Breakdown:
     - 1,612 Ethereum addresses (0x...)
     - 1,476 Solana addresses (base58)
     - 1,430 Bitcoin addresses (bc1q...)
     - 45 Other addresses

4. **15 Unknown Accounts** (various sizes)
   - Need further investigation

### Critical Insight: PDA-Based Architecture

**Domain names are NOT stored in account data.** Instead, Solana's Program Derived Address (PDA) pattern is used:

- **Domain Name → Account Address**: The account address IS the domain identifier
- **PDA Derivation**: Domain name used as seed to derive account address
- **Account Stores**: Properties only (ETH address, SOL address, BTC address, IPFS, etc.)

This means:
```
PDA = derive_address(seeds: [domain_name], program_id: UD_PROGRAM_ID)
account_data = fetch_account(PDA) // contains properties
```

### Reverse Mapping Pattern
The 56-byte accounts (Type 3) enable **property value → domain** lookups:
- Given an ETH address `0x980Af234C55854F43f1A14b55268Dc1850eaD590`
- Find the account `H5ysUre7gpRgxX1evJ62wrJv21pr2W5eH8f45zha8Z7N`
- This account maps back to the domain that owns this property

### Experimental Scripts Created

1. **`local_tests/ud_solana_nft_enumeration.ts`**
   - Initial exploration with 4 strategies
   - Strategy 1: Direct program accounts (13,084 found)
   - Strategy 2: Skipped (would query all Solana NFTs)
   - Strategy 3: Enhanced RPC (requires Helius API)
   - Strategy 4: Account structure analysis

2. **`local_tests/ud_solana_account_decoder.ts`**
   - Categorizes accounts by discriminator
   - Decodes each account type structure
   - Outputs: `ud_account_analysis_detailed.json`

3. **`local_tests/ud_solana_domain_extractor.ts`**
   - Comprehensive extraction of all account types
   - CSV export for analysis
   - Statistics by address type
   - Outputs: `ud_complete_domain_data.json`, `ud_domain_data.csv`

4. **`local_tests/ud_solana_domain_name_finder.ts`**
   - Attempted to find domain names in 121-byte accounts
   - **Result**: Failed (confirmed domain names NOT stored in accounts)
   - Led to PDA-based architecture discovery

## Next Steps

### Immediate: PDA Resolver Implementation
Create script to resolve domains via PDA derivation:
1. Try common seed patterns:
   - `[domain_name.bytes]`
   - `["domain", domain_name.bytes]`
   - `[namehash(domain_name)]`
2. Test with known domain: `thecookingsenpai.demos`
3. Fetch account data to extract properties

### Follow-up Tasks
1. Find or reverse-engineer Anchor IDL for exact PDA derivation logic
2. Implement full resolver: domain name → PDA → properties
3. Integrate with existing UD resolution in node/SDK
4. Add Solana support alongside Polygon/Ethereum/Base/Sonic

## Technical Context

### Dependencies
- `@solana/web3.js` - Solana RPC interaction
- Program ID: `6eLvwb1dwtV5coME517Ki53DojQaRLUctY9qHqAsS9G2`
- RPC: `https://api.mainnet-beta.solana.com` (public)

### Related Code
- Node: `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`
- SDK: `../sdks/src/abstraction/Identities.ts`
- Types: `src/model/entities/types/IdentityTypes.ts`

### Recent Commits
- `34d82b16`: Add Polygon L2 + Ethereum L1 multi-chain support for UD node
- `c12a3d3`: Add Base L2 and Sonic support to UD identity resolution (SDK)

## Reference Data

### Sample Reverse Mappings
```
0x980Af234C55854F43f1A14b55268Dc1850eaD590 → H5ysUre7gpRgxX1evJ62wrJv21pr2W5eH8f45zha8Z7N
CYiaGjPiyyy9RnnvBHuVsHW8RUQA9hiY5a5XEfcdqZWU → 3azEBrkEKi9tWVSLgyq1PqFqWZWy1GoFBYDGd8vbmTwc
bc1q9tdjduu3cyt2ar9phd2fj234jyl0fywluaw0t3 → Byir9tV8j45bnSTng8Nmzzm6yKE3Ubxs7r49xs7UrDmu
```

### 121-byte Account Structure (Identical Across All)
```
Bytes 0-7:   Discriminator (692565c54bfb661a)
Bytes 8-11:  Counter (109)
Bytes 12-15: Unknown (03000000 = 3)
Bytes 16+:   Static strings "domain_properties", "__event_authority"
```

## Key Learnings

1. **Solana Programs Use PDAs**: Unlike Ethereum storage, Solana derives account addresses from seeds
2. **Account Address = Domain ID**: The address itself encodes the domain identity
3. **Reverse Indexes Needed**: Forward lookup (domain→props) uses PDA, reverse (address→domain) needs separate index accounts
4. **Multi-Chain Properties**: UD domains on Solana can point to ETH, SOL, BTC addresses simultaneously
5. **Template Pattern**: The 121-byte accounts are structural templates, not data storage

## Questions to Resolve

1. What is the exact seed pattern for PDA derivation?
2. Where is the Anchor IDL for this program?
3. How are property keys stored (e.g., "crypto.ETH.address")?
4. Are there other account types we haven't discovered?
5. How to query all domains with a specific TLD (e.g., all .demos domains)?
