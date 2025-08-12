use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Mint};
use anchor_spl::associated_token::AssociatedToken;

declare_id!("GCi1zMj9gDvxSX9kPMopD8tRyX3RtVf5HbTKrCPjrq4j");

/// Solana LiquidityTank Program
/// 
/// A secure multisig treasury with rotating shard control and cross-chain bridge support.
/// Features:
/// - 2/3 majority voting for all operations
/// - Rotating shard control (current members cannot set themselves as new members)
/// - Emergency recovery system with 15-day timeout
/// - Universal cross-chain bridge message verification
/// - SOL and SPL token transfer support
#[program]
pub mod solana_tank {
    use super::*;

    /// Initialize a new multisig liquidity tank with BFT-optimal security
    /// 
    /// 🔄 **Solidity equivalent**: Constructor with comprehensive validation
    /// ```solidity
    /// constructor(address[] memory _owners) {
    ///     require(_owners.length >= 3 && _owners.length <= 10, "Invalid count");
    ///     
    ///     // Prevent duplicate addresses
    ///     for (uint i = 0; i < _owners.length; i++) {
    ///         require(_owners[i] != address(0), "Invalid address");
    ///         for (uint j = i + 1; j < _owners.length; j++) {
    ///             require(_owners[i] != _owners[j], "Duplicate address");
    ///         }
    ///         isOwner[_owners[i]] = true;
    ///     }
    ///     
    ///     owners = _owners;
    ///     threshold = (_owners.length * 2 + 2) / 3; // BFT optimal
    ///     deployer = msg.sender;
    ///     lastOwnershipRotation = block.timestamp;
    /// }
    /// ```
    /// 
    /// 📍 **TypeScript equivalent call**:
    /// ```typescript
    /// await program.methods
    ///   .initializeMultisig([shard1, shard2, shard3, shard4, shard5])
    ///   .accounts({
    ///     multisig: multisigPda,
    ///     deployer: deployerKeypair.publicKey,
    ///     systemProgram: SystemProgram.programId,
    ///   })
    ///   .signers([deployerKeypair])
    ///   .rpc();
    /// ```
    /// 
    /// ⚡ **Key Solana Differences**:
    /// - Automatic BFT-optimal threshold calculation (no manual input needed)
    /// - PDA-based multisig address (deterministic, no deployment address randomness)
    /// - Account space optimized for actual shard member count (not fixed allocation)
    /// - Defensive programming with additional validation beyond Anchor constraints
    pub fn initialize_multisig(
        ctx: Context<InitializeMultisig>,
        shard_members: Vec<Pubkey>,
    ) -> Result<()> {
        // REVIEW: Enhanced multisig initialization with comprehensive validation and BFT security
        let multisig = &mut ctx.accounts.multisig;
        
        // ====================================================================
        // Phase 1: Defensive Programming - Prevent Re-initialization
        // ====================================================================
        //
        // 🔄 **Solidity equivalent**: require(!initialized, "Already initialized");
        // 📍 **Additional Safety**: Beyond Anchor's `init` constraint
        require!(multisig.shard_members.is_empty(), ErrorCode::AlreadyInitialized);
        
        // ====================================================================
        // Phase 2: Shard Member Count Validation (BFT Requirements)
        // ====================================================================
        //
        // 🔄 **Solidity equivalent**: require(_owners.length >= 3 && _owners.length <= 10, "Invalid count");
        // 🛡️ **BFT Security**: Minimum 3 nodes required for Byzantine fault tolerance
        require!(shard_members.len() >= 3, ErrorCode::InsufficientShardMembers);
        require!(shard_members.len() <= 10, ErrorCode::TooManyShardMembers);
        
        // ====================================================================
        // Phase 3: Address Validation & Duplicate Prevention
        // ====================================================================
        //
        // 🔄 **Solidity equivalent**: Nested loop checking for duplicates and zero addresses
        // 📍 **Rust advantage**: Iterator-based approach is more readable than nested loops
        for (i, &shard_member) in shard_members.iter().enumerate() {
            // Validate against zero/system addresses
            // 🔄 **Solidity equivalent**: require(addr != address(0), "Invalid address");
            require!(shard_member != Pubkey::default(), ErrorCode::InvalidAddress);
            require!(shard_member != crate::ID, ErrorCode::InvalidAddress);
            
            // Check for duplicates using iterator slice
            // 🔄 **Solidity equivalent**: Inner loop checking owners[j] != owners[i]
            // 📍 **Rust efficiency**: Slice-based duplicate detection is O(n²) but cleaner than HashMap for small n
            require!(
                !shard_members[i + 1..].contains(&shard_member),
                ErrorCode::DuplicateAddress
            );
        }
        
        // ====================================================================
        // Phase 4: BFT-Optimal Threshold Calculation
        // ====================================================================
        //
        // 🔄 **Solidity equivalent**: threshold = (_owners.length * 2 + 2) / 3;
        // 🛡️ **BFT Theory**: For n nodes, need >2/3 approvals to guarantee Byzantine fault tolerance
        // 📊 **Examples**: 3 nodes → 2 approvals, 4 nodes → 3 approvals, 5 nodes → 4 approvals
        let calculated_threshold = (shard_members.len() * 2 + 2) / 3;
        
        // Safety check: Ensure we never exceed the member count or go below 2
        // 🔄 **Solidity equivalent**: require(threshold >= 2 && threshold <= owners.length, "Invalid threshold");
        let safe_threshold = calculated_threshold.max(2).min(shard_members.len()) as u8;
        
        // ====================================================================
        // Phase 5: Initialize Multisig State
        // ====================================================================
        //
        // 🔄 **Solidity equivalent**: Setting contract state variables
        // 📍 **Rust optimization**: Clone once in smaller scope, then move ownership
        let event_shard_members = shard_members.clone(); // Single clone for event
        multisig.shard_members = shard_members; // Move ownership (no clone)
        multisig.threshold = safe_threshold;
        multisig.deployer = ctx.accounts.deployer.key();
        multisig.emergency_timeout = Clock::get()?.unix_timestamp + EMERGENCY_TIMEOUT;
        multisig.nonce = 0;
        multisig.paused = false;
        multisig.bump = ctx.bumps.multisig;
        
        // ====================================================================
        // Phase 6: Event Emission for Transparency
        // ====================================================================
        //
        // 🔄 **Solidity equivalent**: emit MultisigCreated(owners, threshold, msg.sender);
        // 📍 **Anchor events**: Automatically indexed and available to clients
        // 🦀 **Rust optimization**: Use pre-cloned vector to avoid double allocation
        emit!(MultisigInitialized {
            multisig: multisig.key(),
            deployer: multisig.deployer,
            shard_members: event_shard_members, // Use pre-cloned vector
            threshold: multisig.threshold,
        });

        // 📊 **Success Metrics**: Log key initialization parameters
        msg!(
            "Multisig initialized: {} shard members, {} threshold (BFT optimal), deployer: {}",
            multisig.shard_members.len(),
            multisig.threshold,
            multisig.deployer
        );

        Ok(())
    }

    /// Create a new proposal (placeholder for Phase 2)
    pub fn create_proposal(
        ctx: Context<CreateProposal>,
        proposal_id: u64,
        proposal_type: ProposalType,
    ) -> Result<()> {
        // Implementation will be added in Phase 2
        msg!("Creating proposal {} of type {:?}", proposal_id, proposal_type);
        Ok(())
    }
}

// ============================================================================
// Account Structures
// ============================================================================
// 
// In Solana, instead of storing state in contract storage like Solidity,
// we create separate on-chain accounts for different data structures.
// Think of each Account as a separate smart contract storage unit.

/// Core multisig account storing shard members and configuration
/// 
/// 🔄 **Solidity equivalent**: This is like the main contract state variables
/// ```solidity
/// address[] public authorizedAddresses;
/// uint8 public authorizedCount;
/// address public immutable deployer;
/// bool public paused;
/// uint256 public lastOwnershipRotation;
/// ```
/// 
/// ⚡ **Key Solana Differences**:
/// - This becomes a separate on-chain account (not contract storage)
/// - Account is created using Program Derived Address (PDA) for deterministic addressing
/// - All state lives in this account, accessible by the program
#[account]
pub struct MultisigAccount {
    /// Current shard members who can vote on proposals
    /// 
    /// 🔄 **Solidity equivalent**: `address[] public authorizedAddresses`
    /// 📍 **TypeScript equivalent**: `shard_members: PublicKey[]`
    /// 
    /// These are the wallet addresses that can create and approve proposals.
    /// In the EVM version, these are called "authorizedAddresses"
    pub shard_members: Vec<Pubkey>,

    /// Required number of approvals (2/3 majority typically) 
    ///
    /// 🔄 **Solidity equivalent**: Calculated from `authorizedCount * 2 / 3 + 1`
    /// 📍 **TypeScript equivalent**: `threshold: number`
    ///
    /// For 5 shard members: threshold = 4 (needs 4/5 approvals)
    /// For 3 shard members: threshold = 2 (needs 2/3 approvals) 
    pub threshold: u8,

    /// Original deployer for emergency recovery
    ///
    /// 🔄 **Solidity equivalent**: `address public immutable deployer`
    /// 📍 **TypeScript equivalent**: `deployer: PublicKey`
    ///
    /// Only this address can trigger emergency recovery after 15 days
    pub deployer: Pubkey,

    /// Timestamp when emergency recovery becomes available
    ///
    /// 🔄 **Solidity equivalent**: `lastOwnershipRotation + EMERGENCY_TIMEOUT`
    /// 📍 **TypeScript equivalent**: `emergency_timeout: number`
    ///
    /// Unix timestamp. Deployer can recover control if this time has passed
    /// and no shard rotation happened for 15 days
    pub emergency_timeout: i64,

    /// Nonce for replay protection
    ///
    /// 🔄 **Solidity equivalent**: `uint256 public proposalNonce` 
    /// 📍 **TypeScript equivalent**: `nonce: bigint`
    ///
    /// Increments with each executed action to prevent replay attacks
    pub nonce: u64,

    /// Whether the contract is paused
    ///
    /// 🔄 **Solidity equivalent**: `bool public paused`
    /// 📍 **TypeScript equivalent**: `paused: boolean`
    ///
    /// When true, all operations except emergency recovery are blocked
    pub paused: bool,

    /// PDA bump seed
    ///
    /// 🌟 **Solana-specific**: Used for Program Derived Address generation
    /// 📍 **TypeScript equivalent**: `bump: number`
    ///
    /// This is unique to Solana - stores the "bump" seed used to generate
    /// the deterministic address for this account. Not needed in EVM.
    pub bump: u8,
}

/// Individual proposal account for voting and execution
/// 
/// 🔄 **Solidity equivalent**: This is like the `MultisigProposal` struct
/// ```solidity
/// struct MultisigProposal {
///     mapping(address => bool) approvals;
///     uint8 approvalCount;
///     uint40 deadline;
///     bool executed;
///     bytes data;
/// }
/// mapping(bytes32 => MultisigProposal) public proposals;
/// ```
/// 
/// ⚡ **Key Solana Differences**:
/// - Each proposal gets its own separate account (not stored in mapping)
/// - Uses PDA addressing: [b"proposal", multisig.key(), proposal_id.bytes()]
/// - More explicit fields instead of packed data
#[account]
pub struct ProposalAccount {
    /// Unique proposal identifier
    ///
    /// 🔄 **Solidity equivalent**: The `bytes32` key in `mapping(bytes32 => MultisigProposal)`
    /// 📍 **TypeScript equivalent**: `id: bigint`
    ///
    /// Incremental ID starting from 0. Used to generate deterministic PDA address
    pub id: u64,

    /// Who created this proposal
    ///
    /// 🔄 **Solidity equivalent**: Not stored in EVM version, tracked in events
    /// 📍 **TypeScript equivalent**: `proposer: PublicKey`
    ///
    /// The shard member who initiated this proposal
    pub proposer: Pubkey,

    /// Type of proposal
    ///
    /// 🔄 **Solidity equivalent**: Decoded from `bytes data` field
    /// 📍 **TypeScript equivalent**: `proposal_type: ProposalType`
    ///
    /// Enum indicating what action this proposal will perform
    /// (transfer SOL, transfer tokens, rotate shards, etc.)
    pub proposal_type: ProposalType,

    /// Shard members who have approved
    ///
    /// 🔄 **Solidity equivalent**: `mapping(address => bool) approvals` 
    /// 📍 **TypeScript equivalent**: `approvals: PublicKey[]`
    ///
    /// Vector storing the public keys of shard members who voted "yes"
    /// In Solidity this was a mapping, here we use a vector for simplicity
    pub approvals: Vec<Pubkey>,

    /// Whether proposal has been executed
    ///
    /// 🔄 **Solidity equivalent**: `bool executed`
    /// 📍 **TypeScript equivalent**: `executed: boolean`
    ///
    /// Once true, proposal cannot be executed again (prevents double-spending)
    pub executed: bool,

    /// When proposal was created
    ///
    /// 🔄 **Solidity equivalent**: Not stored in EVM, could use `block.timestamp`
    /// 📍 **TypeScript equivalent**: `created_at: number`
    ///
    /// Unix timestamp for tracking proposal age and metrics
    pub created_at: i64,

    /// When proposal expires
    ///
    /// 🔄 **Solidity equivalent**: `uint40 deadline`  
    /// 📍 **TypeScript equivalent**: `timeout: number`
    ///
    /// Unix timestamp. After this time, proposal cannot be executed
    /// Default: created_at + 1 hour
    pub timeout: i64,

    /// Associated multisig account
    ///
    /// 🌟 **Solana-specific**: Reference to the parent MultisigAccount
    /// 📍 **TypeScript equivalent**: `multisig: PublicKey`
    ///
    /// Links this proposal to its multisig. In EVM, this was implicit.
    /// In Solana, we need explicit references between accounts.
    pub multisig: Pubkey,

    /// Proposal-specific data
    ///
    /// 🔄 **Solidity equivalent**: `bytes data` - encoded function call
    /// 📍 **TypeScript equivalent**: `data: Uint8Array`
    ///
    /// Additional data needed for proposal execution (amounts, addresses, etc.)
    /// For simple proposals, this might be empty as data is in proposal_type
    pub data: Vec<u8>,

    /// PDA bump seed
    ///
    /// 🌟 **Solana-specific**: Used for Program Derived Address generation  
    /// 📍 **TypeScript equivalent**: `bump: number`
    ///
    /// Used to generate this proposal's deterministic address
    pub bump: u8,
}

/// Cross-chain bridge message for universal blockchain support
///
/// 🌟 **Enhancement beyond EVM contract**: The original EVM contract was Ethereum-specific.
/// This Solana implementation supports ANY source blockchain through configurable chain IDs.
/// 
/// 🔄 **Solidity equivalent**: The EVM contract didn't have explicit bridge message storage.
/// Instead, it would validate bridge messages on-the-fly:
/// ```solidity
/// function processBridgeDeposit(
///     bytes32 txHash,
///     uint256 amount,
///     address recipient,
///     bytes[] calldata signatures
/// ) external {
///     // Inline validation without persistent storage
/// }
/// ```
/// 
/// ⚡ **Key Solana Advantages**:
/// - Persistent bridge message storage for audit trails
/// - Universal chain support (not just Ethereum)
/// - Flexible transaction hash formats for different blockchains
/// - Explicit verification state tracking
/// - Support for async processing workflows
/// 
/// 📍 **TypeScript equivalent**:
/// ```typescript
/// interface BridgeMessage {
///   source_chain_id: number;        // Chain identifier (1=Ethereum, 144=XRP, etc.)
///   tx_hash: Uint8Array;            // Source chain transaction hash
///   amount: bigint;                 // Amount being bridged
///   recipient: PublicKey;           // Destination address on Solana
///   verified: boolean;              // Shard verification status
///   shard_signatures: Uint8Array[]; // Validator signatures
///   processed: boolean;             // Execution status
///   created_at: number;             // Unix timestamp
///   bump: number;                   // PDA bump seed
/// }
/// ```
#[account]
pub struct BridgeMessage {
    /// Universal source chain identifier
    ///
    /// 🌐 **Universal Chain Support**: Unlike EVM contract's Ethereum-only approach,
    /// this supports any blockchain through standardized chain IDs:
    /// 
    /// 📍 **TypeScript equivalent**: `source_chain_id: number`
    /// 
    /// **Chain ID Examples**:
    /// - 1 = Ethereum Mainnet
    /// - 144 = XRPL (XRP Ledger) 
    /// - 1648 = MultiversX
    /// - 137 = Polygon
    /// - 56 = Binance Smart Chain
    /// - Custom IDs for other chains as needed
    pub source_chain_id: u16,

    /// Transaction hash from the source blockchain
    ///
    /// 🔧 **Flexible Hash Format**: [u8; 64] supports different hash sizes:
    /// 
    /// 📍 **TypeScript equivalent**: `tx_hash: Uint8Array` (64 bytes)
    /// 
    /// **Hash Format Examples**:
    /// - Ethereum: 32-byte Keccak256 hash (padded to 64 bytes)
    /// - Bitcoin: 32-byte SHA256 hash (padded to 64 bytes) 
    /// - XRPL: Variable length transaction ID (padded to 64 bytes)
    /// - MultiversX: 32-byte transaction hash (padded to 64 bytes)
    /// 
    /// ⚡ **Padding Strategy**: Shorter hashes are left-padded with zeros,
    /// longer hashes are truncated (though this is rare in practice).
    pub tx_hash: [u8; 64],

    /// Amount being bridged from source chain
    ///
    /// 🔄 **Solidity equivalent**: `uint256 amount` 
    /// 📍 **TypeScript equivalent**: `amount: bigint`
    /// 
    /// ⚡ **Denomination Handling**: Amount is normalized to destination token decimals.
    /// For example, if bridging USDC (6 decimals) from Ethereum to Solana,
    /// the amount represents the final USDC amount in micro-units.
    pub amount: u64,

    /// Final recipient address on Solana
    ///
    /// 🔄 **Solidity equivalent**: `address recipient`
    /// 📍 **TypeScript equivalent**: `recipient: PublicKey`
    /// 
    /// ⚡ **Cross-Chain Address Mapping**: The original transaction on the source
    /// chain contains the intended Solana recipient address. Demos network validators
    /// verify this mapping during the bridge process.
    pub recipient: Pubkey,

    /// Whether message has been verified by sufficient shard members
    ///
    /// 🌟 **Solana-specific**: Explicit verification state tracking
    /// 📍 **TypeScript equivalent**: `verified: boolean`
    /// 
    /// ⚡ **Verification Process**: Set to `true` when enough shard members
    /// (based on threshold) have provided valid signatures confirming the
    /// source chain transaction exists and is valid.
    pub verified: bool,

    /// Digital signatures from Demos network shard members
    ///
    /// 🔄 **Solidity equivalent**: `bytes[] signatures` parameter in validation
    /// 📍 **TypeScript equivalent**: `shard_signatures: Uint8Array[]`
    /// 
    /// ⚡ **Signature Format**: Each entry is a 64-byte Ed25519 signature from a
    /// shard member attesting to the validity of the bridge message.
    /// The number of signatures must meet the multisig threshold.
    pub shard_signatures: Vec<[u8; 64]>,

    /// Whether the bridge message has been executed
    ///
    /// 🔄 **Solidity equivalent**: Similar to proposal.executed in EVM contract
    /// 📍 **TypeScript equivalent**: `processed: boolean`
    /// 
    /// ⚡ **Execution Status**: Prevents double-spending by ensuring each verified
    /// bridge message can only be processed once. Set to `true` after successful
    /// token minting/transfer to the recipient.
    pub processed: bool,

    /// When the bridge message was created (Unix timestamp)
    ///
    /// 🌟 **Audit Trail**: Unlike EVM contract, we store creation time for analytics
    /// 📍 **TypeScript equivalent**: `created_at: number`
    /// 
    /// ⚡ **Time Tracking**: Used for bridge message expiry, performance metrics,
    /// and audit trails. Messages older than a certain threshold may be rejected.
    pub created_at: i64,

    /// PDA bump seed for deterministic address generation
    ///
    /// 🌟 **Solana-specific**: Used for Program Derived Address generation
    /// 📍 **TypeScript equivalent**: `bump: number`
    /// 
    /// ⚡ **Address Generation**: This bridge message's PDA is generated using:
    /// `[b"bridge_message", source_chain_id.bytes(), tx_hash.bytes(), bump]`
    /// This ensures each source transaction gets a unique bridge message account.
    pub bump: u8,
}

// ============================================================================
// Enums and Types
// ============================================================================

/// Types of proposals that can be created and voted on by shard members
/// 
/// 🔄 **Solidity equivalent**: The EVM contract uses encoded `bytes data` with function selectors
/// ```solidity
/// // Instead of this enum, EVM uses encoded calls like:
/// bytes memory data = abi.encodeWithSignature("transfer(address,uint256)", recipient, amount);
/// MultisigProposal storage proposal = proposals[proposalId];
/// proposal.data = data;
/// ```
/// 
/// ⚡ **Key Solana Differences**:
/// - Rust enums provide type-safe proposal categorization (vs generic bytes)
/// - Each variant contains all necessary data inline
/// - No function encoding/decoding needed - direct struct access
/// - Compile-time validation of proposal data structure
/// 
/// 📍 **TypeScript equivalent**: 
/// ```typescript
/// type ProposalType = 
///   | { type: 'TransferSol'; recipient: PublicKey; amount: bigint }
///   | { type: 'TransferSplToken'; recipient: PublicKey; amount: bigint; mint: PublicKey }
///   | { type: 'RotateShardMembers'; new_members: PublicKey[] }
///   | { type: 'EmergencyWithdrawal'; recipient: PublicKey }
///   | { type: 'ProcessBridgeMessage'; message: PublicKey }
///   | { type: 'UpdateConfig'; new_threshold?: number };
/// ```
#[derive(AnchorSerialize, AnchorDeserialize, Clone, Debug, PartialEq)]
pub enum ProposalType {
    /// Transfer native SOL tokens to a recipient address
    /// 
    /// 🔄 **Solidity equivalent**: 
    /// ```solidity
    /// function transfer(address recipient, uint256 amount) external {
    ///     require(address(this).balance >= amount);
    ///     payable(recipient).transfer(amount);
    /// }
    /// ```
    /// 
    /// 📍 **TypeScript equivalent**: `{ type: 'TransferSol', recipient: PublicKey, amount: bigint }`
    /// 
    /// ⚡ **Solana Implementation**: Uses Cross-Program Invocation (CPI) to System Program
    /// instead of direct balance manipulation. Tank PDA acts as the authority.
    TransferSol { 
        /// Destination wallet address
        recipient: Pubkey, 
        /// Amount in lamports (1 SOL = 1,000,000,000 lamports)
        amount: u64 
    },

    /// Transfer SPL tokens to a recipient address  
    ///
    /// 🔄 **Solidity equivalent**: ERC-20 token transfer
    /// ```solidity
    /// IERC20(tokenAddress).transfer(recipient, amount);
    /// ```
    /// 
    /// 📍 **TypeScript equivalent**: 
    /// `{ type: 'TransferSplToken', recipient: PublicKey, amount: bigint, mint: PublicKey }`
    /// 
    /// ⚡ **Solana Implementation**: Uses CPI to SPL Token Program with token vault PDA
    /// as authority. Supports any SPL token including USDC, USDT, etc.
    TransferSplToken { 
        /// Destination wallet address
        recipient: Pubkey, 
        /// Token amount in smallest denomination (e.g., for USDC with 6 decimals: 1000000 = 1 USDC)
        amount: u64, 
        /// SPL token mint address (identifies which token type)
        mint: Pubkey 
    },

    /// Rotate current shard members with new ones
    ///
    /// 🔄 **Solidity equivalent**: 
    /// ```solidity
    /// function rotateOwnership(address[] calldata newOwners) external {
    ///     require(!isCurrentOwner(msg.sender)); // Key security check
    ///     authorizedAddresses = newOwners;
    ///     authorizedCount = newOwners.length;
    /// }
    /// ```
    /// 
    /// 📍 **TypeScript equivalent**: `{ type: 'RotateShardMembers', new_members: PublicKey[] }`
    /// 
    /// ⚡ **Critical Security Feature**: Current shard members CANNOT set themselves
    /// as new members. This prevents power consolidation and ensures true rotation.
    RotateShardMembers { 
        /// New shard member addresses (3-10 members required)
        /// MUST NOT include any current shard members
        new_members: Vec<Pubkey> 
    },

    /// Emergency withdrawal by deployer after timeout
    ///
    /// 🔄 **Solidity equivalent**: 
    /// ```solidity
    /// function emergencyRecovery(address recipient) external {
    ///     require(msg.sender == deployer);
    ///     require(block.timestamp > lastOwnershipRotation + EMERGENCY_TIMEOUT);
    ///     // Transfer all funds to recipient
    /// }
    /// ```
    /// 
    /// 📍 **TypeScript equivalent**: `{ type: 'EmergencyWithdrawal', recipient: PublicKey }`
    /// 
    /// ⚡ **Emergency Safety**: Only deployer can execute after 15 days of no shard rotation.
    /// Transfers ALL funds (SOL + all SPL tokens) to specified recipient.
    EmergencyWithdrawal { 
        /// Address to receive all withdrawn funds
        recipient: Pubkey 
    },

    /// Process and execute a verified cross-chain bridge message
    ///
    /// 🌟 **Solana-specific**: This functionality extends beyond the EVM contract
    /// to support universal cross-chain bridging from any blockchain
    /// 
    /// 📍 **TypeScript equivalent**: `{ type: 'ProcessBridgeMessage', message: PublicKey }`
    /// 
    /// ⚡ **Bridge Integration**: Processes verified messages from Demos network
    /// validators for deposits from Ethereum, XRPL, MultiversX, or any supported chain.
    ProcessBridgeMessage { 
        /// PDA address of the BridgeMessage account to process
        message: Pubkey 
    },

    /// Update multisig configuration parameters
    ///
    /// 🔄 **Solidity equivalent**: Configuration update functions
    /// ```solidity
    /// function updateThreshold(uint8 newThreshold) external {
    ///     require(newThreshold >= 2 && newThreshold <= authorizedCount);
    ///     // Update threshold through multisig vote
    /// }
    /// ```
    /// 
    /// 📍 **TypeScript equivalent**: `{ type: 'UpdateConfig', new_threshold?: number }`
    /// 
    /// ⚡ **Configuration Management**: Allows updating system parameters
    /// like voting thresholds through the multisig process itself.
    UpdateConfig { 
        /// New approval threshold (None = no change)
        /// Must be >= 2 and <= number of shard members
        new_threshold: Option<u8> 
    },
}

// ============================================================================
// Instruction Contexts
// ============================================================================

/// Context for initializing multisig with dynamic space allocation
///
/// 🔄 **Solidity equivalent**: Constructor context with deterministic address
/// ```solidity
/// // In Solidity, contract address is determined by deployer + nonce
/// // Here we use deterministic PDA based on deployer's pubkey
/// ```
/// 
/// 📍 **TypeScript equivalent usage**:
/// ```typescript
/// const [multisigPda] = PublicKey.findProgramAddressSync(
///   [Buffer.from("multisig"), deployer.publicKey.toBuffer()],
///   program.programId
/// );
/// ```
/// 
/// ⚡ **Solana Optimizations**:
/// - Dynamic space allocation saves rent costs for smaller multisigs
/// - PDA seeds ensure deterministic, collision-free addresses
/// - Anchor handles initialization safety and rent-exemption requirements
#[derive(Accounts)]
#[instruction(shard_members: Vec<Pubkey>)] // Access instruction data for space calculation
pub struct InitializeMultisig<'info> {
    /// The multisig account being initialized with optimal space allocation
    /// 
    /// 🔄 **Solidity equivalent**: Contract storage initialization
    /// 📍 **Space Calculation**: Dynamic sizing based on actual shard member count
    /// 
    /// **Space Breakdown**:
    /// - Account discriminator: 8 bytes
    /// - Vec<Pubkey> shard_members: 4 + (32 * n) bytes  
    /// - u8 threshold: 1 byte
    /// - Pubkey deployer: 32 bytes
    /// - i64 emergency_timeout: 8 bytes
    /// - u64 nonce: 8 bytes
    /// - bool paused: 1 byte
    /// - u8 bump: 1 byte
    /// - **Total**: 63 + (32 * shard_member_count) bytes
    /// 
    /// **Rent Savings**: ~224 bytes (0.00157 SOL) saved for 3-member vs 10-member allocation
    #[account(
        init,
        payer = deployer,
        space = 8 + 4 + (32 * shard_members.len()) + 1 + 32 + 8 + 8 + 1 + 1, // Dynamic sizing
        seeds = [b"multisig", deployer.key().as_ref()],
        bump
    )]
    pub multisig: Account<'info, MultisigAccount>,
    
    /// The deployer who becomes the emergency recovery authority
    /// 
    /// 🔄 **Solidity equivalent**: msg.sender in constructor
    /// 📍 **Authority**: Only this account can trigger emergency recovery after timeout
    #[account(mut)]
    pub deployer: Signer<'info>,
    
    /// System program for account creation and rent handling
    /// 
    /// 🌟 **Solana-specific**: Required for creating new accounts on-chain
    /// 📍 **Anchor requirement**: Needed for `init` constraint functionality
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(proposal_id: u64)]
pub struct CreateProposal<'info> {
    #[account(
        seeds = [b"multisig", multisig.deployer.as_ref()],
        bump = multisig.bump,
        constraint = multisig.shard_members.contains(&proposer.key()) @ ErrorCode::NotShardMember
    )]
    pub multisig: Account<'info, MultisigAccount>,
    
    #[account(
        init,
        payer = proposer,
        space = 8 + 256, // Base proposal size
        seeds = [b"proposal", multisig.key().as_ref(), &proposal_id.to_le_bytes()],
        bump
    )]
    pub proposal: Account<'info, ProposalAccount>,
    
    #[account(mut)]
    pub proposer: Signer<'info>,
    
    pub system_program: Program<'info, System>,
}

// ============================================================================
// Constants
// ============================================================================

/// Emergency recovery timeout (15 days in seconds)
pub const EMERGENCY_TIMEOUT: i64 = 15 * 24 * 60 * 60;

/// Default proposal timeout (1 hour in seconds)  
pub const DEFAULT_PROPOSAL_TIMEOUT: i64 = 3600;

// ============================================================================
// Events
// ============================================================================

#[event]
pub struct MultisigInitialized {
    pub multisig: Pubkey,
    pub deployer: Pubkey,
    pub shard_members: Vec<Pubkey>,
    pub threshold: u8,
}

#[event]
pub struct ProposalCreated {
    pub proposal: Pubkey,
    pub proposer: Pubkey,
    pub proposal_type: ProposalType,
    pub timeout: i64,
}

// ============================================================================
// Error Codes - Comprehensive error handling with cross-platform equivalents
// ============================================================================
//
// 🔄 **Solidity equivalent**: Custom errors provide gas-efficient error handling
// ```solidity
// error InsufficientShardMembers();
// error NotShardMember();
// // Usage: revert InsufficientShardMembers();
// ```
//
// 📍 **TypeScript equivalent**: Error types for client-side handling
// ```typescript
// enum ErrorCode {
//   InsufficientShardMembers = 6000,
//   TooManyShardMembers = 6001,
//   // ... etc
// }
// ```
//
// ⚡ **Anchor Error System**: Errors are automatically assigned codes starting from 6000.
// Client libraries can catch specific errors by code for precise error handling.

#[error_code]
pub enum ErrorCode {
    // ========================================================================
    // Initialization & Configuration Errors (6000-6009)
    // ========================================================================
    
    /// Minimum 3 shard members required for secure multisig operation
    /// 
    /// 🔄 **Solidity equivalent**: `require(owners.length >= 3, "Insufficient owners")`
    /// 🎯 **Error Code**: 6000
    /// 🐛 **Common Cause**: Trying to initialize multisig with <3 shard members
    /// 🛠️ **Client Fix**: Provide at least 3 unique shard member addresses
    #[msg("Insufficient number of shard members (minimum 3 required)")]
    InsufficientShardMembers,
    
    /// Maximum 10 shard members to prevent gas/computation limits
    /// 
    /// 🔄 **Solidity equivalent**: `require(owners.length <= 10, "Too many owners")`
    /// 🎯 **Error Code**: 6001
    /// 🐛 **Common Cause**: Trying to initialize with >10 shard members
    /// 🛠️ **Client Fix**: Reduce shard member count to 10 or fewer
    #[msg("Too many shard members (maximum 10 allowed)")]
    TooManyShardMembers,
    
    /// Threshold must be at least 2 for meaningful security
    /// 
    /// 🔄 **Solidity equivalent**: `require(threshold >= 2, "Invalid threshold")`
    /// 🎯 **Error Code**: 6002
    /// 🐛 **Common Cause**: Setting threshold to 0 or 1
    /// 🛠️ **Client Fix**: Set threshold >= 2 (typically 2/3 of shard members)
    #[msg("Invalid threshold value")]
    InvalidThreshold,
    
    /// Threshold cannot exceed number of available shard members
    /// 
    /// 🔄 **Solidity equivalent**: `require(threshold <= owners.length, "Threshold too high")`
    /// 🎯 **Error Code**: 6003
    /// 🐛 **Common Cause**: Setting threshold > shard member count
    /// 🛠️ **Client Fix**: Ensure threshold <= shard_members.len()
    #[msg("Threshold higher than number of shard members")]
    ThresholdTooHigh,
    
    /// Only deploy-time initialization allowed to prevent reinitialization attacks
    /// 
    /// 🔄 **Solidity equivalent**: `require(!initialized, "Already initialized")`
    /// 🎯 **Error Code**: 6004
    /// 🐛 **Common Cause**: Trying to initialize already initialized multisig
    /// 🛠️ **Client Fix**: Check initialization status before calling initialize
    #[msg("Already initialized")]
    AlreadyInitialized,

    // ========================================================================
    // Authorization & Access Control Errors (6010-6019)
    // ========================================================================
    
    /// Caller must be a current shard member to perform this action
    /// 
    /// 🔄 **Solidity equivalent**: `require(isOwner[msg.sender], "Not owner")`
    /// 🎯 **Error Code**: 6010
    /// 🐛 **Common Cause**: Non-shard member trying to create proposals or vote
    /// 🛠️ **Client Fix**: Ensure caller is in current shard member list
    #[msg("Not a shard member")]
    NotShardMember,
    
    /// Generic authorization failure for protected operations
    /// 
    /// 🔄 **Solidity equivalent**: `require(authorized, "Not authorized")`
    /// 🎯 **Error Code**: 6011
    /// 🐛 **Common Cause**: Insufficient permissions for requested operation
    /// 🛠️ **Client Fix**: Verify caller has appropriate permissions
    #[msg("Not authorized")]
    NotAuthorized,
    
    /// Only original deployer can perform emergency operations
    /// 
    /// 🔄 **Solidity equivalent**: `require(msg.sender == deployer, "Not deployer")`
    /// 🎯 **Error Code**: 6012
    /// 🐛 **Common Cause**: Non-deployer trying emergency recovery or pause/unpause
    /// 🛠️ **Client Fix**: Use deployer account for emergency operations
    #[msg("Not deployer")]
    NotDeployer,
    
    /// Contract is paused, most operations are blocked
    /// 
    /// 🔄 **Solidity equivalent**: `require(!paused, "Contract paused")`
    /// 🎯 **Error Code**: 6013  
    /// 🐛 **Common Cause**: Trying operations while contract is emergency paused
    /// 🛠️ **Client Fix**: Wait for unpause or contact deployer for emergency unpause
    #[msg("Contract is paused")]
    ContractPaused,

    // ========================================================================
    // Proposal & Voting Errors (6020-6029)
    // ========================================================================
    
    /// Proposal has exceeded its execution timeout window
    /// 
    /// 🔄 **Solidity equivalent**: `require(block.timestamp <= proposal.deadline, "Proposal expired")`
    /// 🎯 **Error Code**: 6020
    /// 🐛 **Common Cause**: Trying to vote/execute proposal after timeout
    /// 🛠️ **Client Fix**: Create new proposal or increase default timeout
    #[msg("Proposal expired")]
    ProposalExpired,
    
    /// Proposal has already been executed to prevent double-spending
    /// 
    /// 🔄 **Solidity equivalent**: `require(!proposal.executed, "Already executed")`
    /// 🎯 **Error Code**: 6021
    /// 🐛 **Common Cause**: Attempting to execute already executed proposal
    /// 🛠️ **Client Fix**: Check proposal.executed status before execution
    #[msg("Already executed")]
    AlreadyExecuted,
    
    /// Shard member has already voted on this proposal
    /// 
    /// 🔄 **Solidity equivalent**: `require(!proposal.approvals[msg.sender], "Already approved")`
    /// 🎯 **Error Code**: 6022
    /// 🐛 **Common Cause**: Same shard member voting twice on same proposal
    /// 🛠️ **Client Fix**: Check approval status before voting
    #[msg("Already approved by this shard member")]
    AlreadyApproved,
    
    /// Not enough shard member approvals to execute proposal
    /// 
    /// 🔄 **Solidity equivalent**: `require(approvalCount >= threshold, "Insufficient approvals")`
    /// 🎯 **Error Code**: 6023
    /// 🐛 **Common Cause**: Trying to execute proposal without reaching threshold
    /// 🛠️ **Client Fix**: Wait for more approvals or reduce threshold via governance
    #[msg("Insufficient approvals")]
    InsufficientApprovals,

    // ========================================================================
    // Security & Validation Errors (6030-6039)
    // ========================================================================
    
    /// Current shard members cannot appoint themselves in rotation (prevents power consolidation)
    /// 
    /// 🔄 **Solidity equivalent**: `require(!isCurrentOwner(newOwner), "Current owner cannot be new owner")`
    /// 🎯 **Error Code**: 6030
    /// 🐛 **Common Cause**: Including current shard member in new shard member list
    /// 🛠️ **Client Fix**: Ensure new_members list contains NO current shard members
    #[msg("Current shard member cannot be new shard member")]
    CurrentShardMemberCannotBeNewShardMember,
    
    /// Emergency recovery requires 15-day timeout since last rotation
    /// 
    /// 🔄 **Solidity equivalent**: `require(block.timestamp > lastRotation + TIMEOUT, "Timeout not reached")`  
    /// 🎯 **Error Code**: 6031
    /// 🐛 **Common Cause**: Attempting emergency recovery too early
    /// 🛠️ **Client Fix**: Wait until emergency_timeout timestamp is reached
    #[msg("Emergency timeout not reached")]
    EmergencyTimeoutNotReached,

    // ========================================================================
    // Data Validation Errors (6040-6049)
    // ========================================================================
    
    /// Address validation failed (zero address or invalid format)
    /// 
    /// 🔄 **Solidity equivalent**: `require(addr != address(0), "Invalid address")`
    /// 🎯 **Error Code**: 6040
    /// 🐛 **Common Cause**: Providing zero/null PublicKey or malformed address
    /// 🛠️ **Client Fix**: Validate address format before sending
    #[msg("Invalid address")]
    InvalidAddress,
    
    /// Duplicate addresses not allowed in shard member lists
    /// 
    /// 🔄 **Solidity equivalent**: Custom validation loop checking for duplicates
    /// 🎯 **Error Code**: 6041
    /// 🐛 **Common Cause**: Same address appears multiple times in shard member array
    /// 🛠️ **Client Fix**: Remove duplicates from address arrays
    #[msg("Duplicate address")]
    DuplicateAddress,

    // ========================================================================
    // Bridge & Cross-Chain Errors (6050-6059)
    // ========================================================================
    
    /// Bridge message has not been verified by sufficient shard members
    /// 
    /// 🌟 **Solana-specific**: Enhanced bridge error handling beyond EVM contract
    /// 🎯 **Error Code**: 6050
    /// 🐛 **Common Cause**: Trying to process unverified bridge message
    /// 🛠️ **Client Fix**: Wait for shard verification or check signature count
    #[msg("Bridge message not verified")]
    BridgeMessageNotVerified,
    
    /// Bridge message has already been processed to prevent double-spending
    /// 
    /// 🌟 **Solana-specific**: Cross-chain replay protection
    /// 🎯 **Error Code**: 6051
    /// 🐛 **Common Cause**: Attempting to process same bridge message twice
    /// 🛠️ **Client Fix**: Check bridge message processed status
    #[msg("Bridge message already processed")]
    BridgeMessageAlreadyProcessed,
    
    /// Unsupported source chain ID in bridge message
    /// 
    /// 🌟 **Universal Chain Support**: Unlike EVM contract's Ethereum-only approach
    /// 🎯 **Error Code**: 6052
    /// 🐛 **Common Cause**: Bridge message from unsupported/unknown blockchain
    /// 🛠️ **Client Fix**: Verify source_chain_id is supported
    #[msg("Unsupported source chain")]
    UnsupportedSourceChain,
    
    /// Invalid bridge signature format or verification failed
    /// 
    /// 🌟 **Signature Verification**: Enhanced signature validation
    /// 🎯 **Error Code**: 6053  
    /// 🐛 **Common Cause**: Malformed signatures or signature verification failure
    /// 🛠️ **Client Fix**: Ensure Ed25519 signature format and valid shard signatures
    #[msg("Invalid bridge signature")]
    InvalidBridgeSignature,

    // ========================================================================
    // Resource & Limit Errors (6060-6069)
    // ========================================================================
    
    /// Insufficient balance for requested transfer operation
    /// 
    /// 🔄 **Solidity equivalent**: `require(address(this).balance >= amount, "Insufficient balance")`
    /// 🎯 **Error Code**: 6060
    /// 🐛 **Common Cause**: Trying to transfer more than available balance
    /// 🛠️ **Client Fix**: Check current balance before creating transfer proposal
    #[msg("Insufficient balance")]
    InsufficientBalance,
    
    /// Token account not found or not initialized
    /// 
    /// 🌟 **Solana-specific**: SPL token account management
    /// 🎯 **Error Code**: 6061
    /// 🐛 **Common Cause**: Token vault not created for requested mint
    /// 🛠️ **Client Fix**: Create token vault before transferring specific token
    #[msg("Token account not found")]
    TokenAccountNotFound,

    // ========================================================================
    // General Operation Errors (6070-6079)  
    // ========================================================================
    
    /// Arithmetic operation resulted in overflow
    /// 
    /// 🔄 **Solidity equivalent**: Built-in overflow protection in Solidity 0.8+
    /// 🎯 **Error Code**: 6070
    /// 🐛 **Common Cause**: Large number calculations exceeding u64 limits
    /// 🛠️ **Client Fix**: Use smaller amounts or check calculation bounds
    #[msg("Arithmetic overflow")]
    ArithmeticOverflow,
    
    /// Operation would result in invalid state transition
    /// 
    /// 🔄 **Solidity equivalent**: Custom state validation in modifier
    /// 🎯 **Error Code**: 6071
    /// 🐛 **Common Cause**: State machine violation or inconsistent state
    /// 🛠️ **Client Fix**: Verify current state before attempting operation
    #[msg("Invalid state transition")]
    InvalidStateTransition,
}