# OmniProtocol Step 1: Message Format Design

## Completed Design Decisions

### Header Structure (12 bytes fixed)
- **Version**: 2 bytes (major.minor semantic versioning)
- **Type**: 1 byte (opcode, 256 message types possible)
- **Flags**: 1 byte (8 bit flags for message characteristics)
- **Length**: 4 bytes (total message length, max 4GB)
- **Message ID**: 4 bytes (request-response correlation, always present)

### Flags Bitmap
- Bit 0: Authentication required (0=no, 1=yes)
- Bit 1: Response expected (0=fire-and-forget, 1=request-response)
- Bit 2: Compression enabled (0=raw, 1=compressed)
- Bit 3: Encrypted (reserved for future)
- Bit 4-7: Reserved

### Authentication Block (variable, conditional on Flags bit 0)
- **Algorithm**: 1 byte (0x01=ed25519, 0x02=falcon, 0x03=ml-dsa)
- **Signature Mode**: 1 byte (versatile signing strategies)
  - 0x01: Sign public key only (HTTP compatibility)
  - 0x02: Sign Message ID only
  - 0x03: Sign full payload
  - 0x04: Sign (Message ID + Payload hash)
  - 0x05: Sign (Message ID + Timestamp)
- **Timestamp**: 8 bytes (Unix timestamp ms, replay protection)
- **Identity Length**: 2 bytes (pubkey length)
- **Identity**: variable bytes (raw public key)
- **Signature Length**: 2 bytes (signature length)
- **Signature**: variable bytes (raw signature)

### Payload Structure
**Response Messages:**
- Status Code: 2 bytes (HTTP-compatible: 200, 400, 401, 429, 500, 501)
- Response Data: variable (message-specific)

**Request Messages:**
- Message-type specific (defined in opcode mapping)

### Design Rationale
1. **Fixed 12-byte header**: Minimal overhead, predictable parsing
2. **Conditional auth block**: Only pay cost when authentication needed
3. **Message ID always present**: Enables request-response without optional fields
4. **Versatile signature modes**: Different security needs for different message types
5. **Timestamp mandatory in auth**: Critical replay protection
6. **Variable length fields**: Future-proof for new crypto algorithms
7. **Status in payload**: Keeps header clean and consistent
8. **Big-endian encoding**: Network byte order standard

### Bandwidth Savings
- Minimum overhead: 12 bytes (vs HTTP ~300-500 bytes)
- With ed25519 auth: 104 bytes (vs HTTP ~500-800 bytes)
- Savings: 60-90% for small messages

### Files Created
- `OmniProtocol/01_MESSAGE_FORMAT.md` - Complete step 1 design
- `OmniProtocol/SPECIFICATION.md` - Master spec (updated with message format)

### Next Step
Design complete opcode mapping for all 40+ message types identified in analysis.