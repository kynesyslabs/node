# Unstoppable Domains Solana - Complete Reverse Engineering

## Session Summary
Successfully reverse engineered UD Solana architecture through comprehensive blockchain analysis and API testing. Discovered properties are stored offchain in centralized database, with only reverse mappings onchain.

## Key Discoveries

### Architecture
- **Hybrid Model**: NFT ownership onchain + properties offchain
- **UD Program**: 13,098 accounts categorized by discriminator
- **Property Storage**: Centralized database (NOT fully onchain)
- **Reverse Mappings**: 4,563 accounts (discriminator: fee975fc4ca6928b)
  - Structure: discriminator(8) + length(4) + value(variable)
  - Purpose: property_value → domain lookups ONLY
  - Contains: Property values as strings (ETH addresses, SOL addresses)
  - Does NOT contain: Mint address, domain reference, or forward mappings

### Critical Finding
**NO forward mapping (mint → properties) exists onchain**
- Searched all 13,098 UD program accounts
- Mint address NOT found in any program account
- Properties NOT stored in domain records accounts (121 bytes)
- Must use UD API or build custom indexer for property resolution

### API Testing Results
Tested with user's API key: `bonqumrr7w13bma65ejnpw7wrynvqffxbqgwsonvvmukyfxh`

**Public Endpoints:**
- ✅ `/metadata/d/{domain}` - Returns: name, tokenId, image, attributes (NO properties)

**Authenticated Endpoints:**
- ✅ `/resolve/domains/{domain}` - Requires: Bearer token
  - Returns: Complete resolution with ALL properties
  - Example response:
    ```json
    {
      "meta": {
        "domain": "dacookingsenpai.demos",
        "tokenId": "FnjuoZCfmKCeJHEAbrnw6RP12HVceHKmQrhRfg5qmVBF",
        "blockchain": "SOL",
        "owner": "3cJDb7KQcWxCrBaGAkcDsYMLGrmBFNRqhnviG2nUXApj"
      },
      "records": {
        "crypto.ETH.address": "0xbe2278A4a281427c852D86dD8ba758cA712F1415",
        "crypto.SOL.address": "CYiaGjPiyyy9RnnvBHuVsHW8RUQA9hiY5a5XEfcdqZWU"
      }
    }
    ```

### Account Types Identified

1. **Domain Records** (discriminator: 692565c54bfb661a, 121 bytes)
   - 4,260 accounts
   - Contains: Domain configuration and metadata
   - Does NOT contain: Property values

2. **Reverse Mappings** (discriminator: fee975fc4ca6928b, 54-56 bytes)
   - 4,563 accounts
   - Contains: Property values as strings
   - Example: ETH address (54 bytes), SOL address (56 bytes)
   - Structure: discriminator(8) + length(4) + value(length)

3. **State Accounts** (discriminator: f7606257698974c2, 24 bytes)
   - 4,253 accounts
   - Template/configuration data

### SDK Analysis
Official `@unstoppabledomains/resolution` SDK:
- ❌ Does NOT support Solana
- ✅ Supports: ETH, POL, ZIL, BASE only
- Cannot be used as solution for Solana domains

## Recommended Solution

**Use UD API with Bearer token authentication**

Reasons:
1. Properties NOT available onchain (only reverse mappings)
2. API is the ONLY reliable way to get properties
3. User has working API key
4. Building custom indexer is complex and not recommended

Implementation:
```typescript
const response = await fetch(
    `https://api.unstoppabledomains.com/resolve/domains/${domain}`,
    {
        headers: {
            "Authorization": `Bearer ${apiKey}`,
        },
    }
)
```

## Integration Path

1. Create resolver in: `src/libs/blockchain/solana/udResolver.ts`
2. Integrate into: `src/libs/blockchain/gcr/gcr_routines/udIdentityManager.ts`
3. Add caching layer to reduce API calls
4. Handle errors gracefully (API down, rate limits)

## Files Created

### Documentation
- `UD_SOLANA_FINDINGS.md` - Complete reverse engineering findings
- `UD_SOLANA_SOLUTION.md` - Integration options comparison
- `UD_FINAL_SOLUTION.md` - Complete solution with code examples

### Test Scripts
- `ud_solana_reverse_engineer.ts` - Owner address analysis
- `ud_solana_nft_resolver.ts` - Metaplex NFT approach
- `ud_solana_mint_resolver.ts` - Mint-based PDA strategies
- `ud_metaplex_metadata_check.ts` - Standard metadata verification
- `ud_final_analysis.ts` - Complete architecture analysis
- `ud_solana_complete_resolver.ts` - Working metadata resolver
- `ud_sdk_inspection.ts` - SDK investigation
- `ud_api_reverse_engineer.ts` - API endpoint testing
- `ud_public_vs_private_analysis.ts` - Public vs authenticated endpoints
- `ud_properties_onchain_search.ts` - Property value blockchain search
- `ud_decode_property_accounts.ts` - Account structure decoding
- `ud_find_all_domain_properties.ts` - Mint-based property search
- `ud_decode_reverse_mapping.ts` - Reverse mapping structure analysis

## Known Limitations

1. Properties NOT stored onchain (centralized database)
2. No forward mapping (mint → properties) exists
3. Requires API key for property resolution
4. SDK doesn't support Solana
5. Custom indexer would be complex to build/maintain

## Next Steps for Integration

1. Implement resolver using UD API with Bearer token
2. Add to udIdentityManager.ts for GCRv2 integration
3. Configure UD_API_KEY in .env
4. Add caching to minimize API calls
5. Test with dacookingsenpai.demos domain
6. Extend to other UD Solana domains
