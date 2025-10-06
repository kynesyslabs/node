# Unstoppable Domains Integration - Architecture Analysis

## Current Identity System Architecture

### Location
`src/libs/abstraction/` - Web2 identity verification system

### Existing Structure
```
src/libs/abstraction/
├── index.ts                    # Main entry point with verifyWeb2Proof()
└── web2/
    ├── parsers.ts              # Abstract Web2ProofParser base class
    ├── github.ts               # GithubProofParser implementation
    ├── twitter.ts              # TwitterProofParser implementation
    └── discord.ts              # DiscordProofParser implementation
```

### Architecture Pattern
**Abstract Base Class Pattern**:
- `Web2ProofParser` (abstract base class in `parsers.ts`)
  - Defines `formats` object for URL validation
  - `verifyProofFormat()` - validates proof URL format
  - `parsePayload()` - parses proof data (format: `prefix:message:algorithm:signature`)
  - `readData()` - abstract method for fetching proof from platform
  - `getInstance()` - abstract static factory method

**Concrete Implementations**:
- `GithubProofParser extends Web2ProofParser`
- `TwitterProofParser extends Web2ProofParser`
- `DiscordProofParser extends Web2ProofParser`

### Verification Flow
1. `verifyWeb2Proof(payload, sender)` in `index.ts`
2. Switch on `payload.context` ("twitter", "github", "discord")
3. Select appropriate parser class
4. Get singleton instance via `getInstance()`
5. Call `readData()` to fetch proof
6. Verify cryptographic signature using `ucrypto.verify()`
7. Return success/failure result

### Proof Format
All proofs follow the same format:
```
prefix:message:algorithm:signature
```

## Unstoppable Domains Integration Plan

### Recommended Approach: New UD Directory
**Structure**:
```
src/libs/abstraction/
├── index.ts
├── web2/                       # Existing
└── ud/                         # New - Unstoppable Domains
    ├── parsers.ts              # UDProofParser base class
    └── unstoppableDomains.ts   # UD implementation
```

**Rationale**:
- Separate directory for UD-specific logic (blockchain-based, not web2 URL proofs)
- Clean architectural separation
- Follows existing organizational pattern
- Extensible for UD-specific features

## UD Integration Technical Requirements

### Reference Documentation
https://docs.unstoppabledomains.com/smart-contracts/quick-start/resolve-domains/

### Expected Flow
1. User provides UD domain (e.g., `alice.crypto`, future: `alice.demos`)
2. Resolve domain to blockchain address via smart contract
3. Verify ownership (user controls the resolved address)
4. Store UD → Demos identity mapping

### Implementation Components Needed
1. **UD Resolution Client**: Interact with UD smart contracts
2. **Domain Validator**: Verify `.crypto`, `.wallet`, etc. (eventually `.demos`)
3. **Ownership Verifier**: Cryptographic proof of domain ownership
4. **Parser/Adapter**: Fit into existing abstraction system

## Next Steps (Phase 1: Local Testing)

### 1. Create Local Testing Environment
```bash
mkdir local_tests
echo "local_tests/" >> .gitignore
```

### 2. Create UD Resolution Test Files
Create standalone TypeScript files in `local_tests/`:
- `ud_basic_resolution.ts` - Basic domain → address resolution
- `ud_ownership_verification.ts` - Verify domain ownership
- `ud_sdk_exploration.ts` - Test UD SDK capabilities

### 3. Research & Document
- UD SDK/contract integration methods
- Authentication patterns for domain ownership
- Supported blockchain networks
- `.demos` TLD preparation requirements

### 4. Design Integration
Based on learnings, design how UD fits into abstraction system:
- New `ud/unstoppableDomains.ts` parser
- Update `verifyWeb2Proof()` or create unified verification
- Define UD proof payload structure
