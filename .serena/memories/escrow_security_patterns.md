# Escrow Security Patterns and Best Practices

## Critical Security Validations

### Input Validation Pattern
All escrow operations must validate:
1. **Length limits**: Platform ≤20 chars, Username ≤100 chars
2. **Unicode normalization**: NFKC normalization to prevent collision attacks
3. **Delimiter protection**: Prevent `:` in platform/username fields
4. **Non-empty validation**: Require trimmed non-empty strings

### Balance Protection Pattern
```typescript
const MAX_BALANCE = BigInt("1000000000000000000000") // 1 sextillion DEM

// Always check overflow before applying
const newBalance = previousBalance + BigInt(amount)
if (newBalance > MAX_BALANCE) {
    // Reject operation
}
```

### Time-Based Validation Pattern
```typescript
const MIN_EXPIRY_DAYS = 1
const MAX_EXPIRY_DAYS = 365 // Prevent indefinite fund locking

// Validate expiry on deposit creation
if (requestedExpiry < MIN_EXPIRY_DAYS || requestedExpiry > MAX_EXPIRY_DAYS) {
    // Reject operation
}
```

### Access Control Pattern
```typescript
// Always check flagged status before allowing fund operations
if (account.flagged) {
    return {
        success: false,
        message: "Account is flagged and cannot perform this operation"
    }
}
```

## Attack Vectors Mitigated

### 1. Unicode Collision Attack
**Attack**: Different Unicode strings generating same hash
**Defense**: NFKC normalization + delimiter validation
**Example**: `alice` vs `ａｌｉｃｅ` (fullwidth) → normalized to same value

### 2. Fund Locking Attack  
**Attack**: Creating escrow with distant future expiry
**Defense**: 365-day maximum expiry validation
**Impact**: Prevents permanent fund locks

### 3. Balance Overflow Attack
**Attack**: Deposit amounts causing integer overflow
**Defense**: BigInt arithmetic + MAX_BALANCE check
**Impact**: Prevents theft via wrapping

### 4. DoS via Large Input
**Attack**: Submitting 10MB usernames to exhaust SHA3 computation
**Defense**: Length limits (20/100 chars)
**Impact**: Protects network from computational DoS

### 5. Flagged Account Bypass
**Attack**: Banned accounts claiming escrow funds
**Defense**: Flagged status check before claim
**Impact**: Enforces access control policies

## Code Review Checklist

When reviewing escrow-related code, verify:
- [ ] All string inputs have length validation
- [ ] Unicode normalization applied to user-provided identifiers
- [ ] BigInt used for all balance arithmetic
- [ ] Overflow checks before balance updates
- [ ] Time-based validations have reasonable bounds
- [ ] Flagged account checks before sensitive operations
- [ ] No delimiter characters allowed in structured identifiers

## Constants Reference

```typescript
// Escrow limits
const MIN_EXPIRY_DAYS = 1
const MAX_EXPIRY_DAYS = 365
const MS_PER_DAY = 24 * 60 * 60 * 1000
const MAX_BALANCE = BigInt("1000000000000000000000")
const MAX_PLATFORM_LENGTH = 20
const MAX_USERNAME_LENGTH = 100

// Rate limits
escrow_deposit: { maxRequests: 10, windowMs: 60000 }
escrow_claim: { maxRequests: 5, windowMs: 60000 }
escrow_refund: { maxRequests: 5, windowMs: 60000 }
```

## Testing Recommendations

### Security Test Cases
1. **Unicode attacks**: Submit fullwidth, combining marks, homographs
2. **Overflow attacks**: Test max values, boundary conditions
3. **DoS attacks**: Submit maximum allowed lengths, measure performance
4. **Time attacks**: Test min/max expiry bounds, expired escrows
5. **Access control**: Verify flagged accounts rejected

### Performance Benchmarks
- Hash computation time with MAX_USERNAME_LENGTH input
- Database query latency with GIN indexes
- Rate limiter eviction performance at 100K IPs
- Point calculation latency (should be 4x faster)
