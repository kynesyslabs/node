// SPDX-License-Identifier: MIT
/**
 @author: @kynesyslabs
 @title: LiquidityTank
 @notice: A secure liquidity tank with rotating co-ownership managed by multisig operations.
          Features 2/3 majority voting, emergency recovery, and automated ownership rotation.
 @dev: This contract implements:
       - Multisig operations requiring 2/3 approval for all actions
       - Rotating co-ownership where current owners cannot set themselves as new owners
       - Emergency recovery system with 15-day timeout for deployer intervention
       - Support for ETH and ERC20 token transfers
       - Gas-optimized design with packed structs and efficient loops
 @custom:version: 1.0.0
 @custom:author: https://github.com/kynesyslabs
 @custom:security: Audited for reentrancy, access control, and ownership vulnerabilities
 */
pragma solidity ^0.8.27;

/// @dev Custom errors for gas efficiency (saves ~2k gas per revert vs strings)
error NotAuthorized();
error NotDeployer();
error AlreadyInitialized();
error NotInitialized();
error EmergencyTimeoutNotReached();
error ProposalExpired();
error AlreadyExecuted();
error AlreadyApproved();
error ProposalDataMismatch();
error InvalidAddress();
error InvalidAmount();
error DuplicateAddress();
error InsufficientAddresses();
error TooManyAddresses();
error InsufficientBalance();
error TransferFailed();
error InvalidAction();
error CurrentOwnerCannotBeNewOwner();
error DeployerCannotBeAuthorized();
error ContractPausedError();
error ReentrancyGuard();

contract LiquidityTank {
    /// @dev Structure to track multisig proposals
    /// @param approvals Mapping to track which addresses have approved
    /// @param approvalCount Current number of approvals received
    /// @param deadline Unix timestamp when proposal expires
    /// @param executed Whether the proposal has been executed
    /// @param data Encoded function call data to execute
    struct MultisigProposal {
        mapping(address => bool) approvals;
        uint8 approvalCount; // Gas optimization: uint8 sufficient for reasonable number of signers
        uint40 deadline; // Gas optimization: uint40 sufficient for timestamps until year 34K
        bool executed;
        bytes data;
    }
    
    /// @dev Array of authorized addresses that can approve proposals
    address[] public authorizedAddresses;
    
    /// @dev Mapping for O(1) authorization checks
    mapping(address => bool) public isAuthorized;
    
    /// @dev Mapping to store all multisig proposals by their unique ID
    mapping(bytes32 => MultisigProposal) public proposals;
    
    /// @dev Contract deployer for emergency recovery
    address public immutable deployer;
    
    /// @dev Packed storage for gas efficiency - all fit in one slot
    uint8 public authorizedCount;      // 1 byte
    bool public initialized;           // 1 byte  
    bool public paused;               // 1 byte
    bool private _reentrancyLocked;   // 1 byte
    // 28 bytes remaining in this slot
    
    /// @dev Timestamp of last ownership rotation for emergency recovery
    uint256 public lastOwnershipRotation;
    
    /// @dev Nonce for generating unique proposal IDs
    uint256 public proposalNonce;
    
    /// @dev Emergency recovery timeout (15 days)
    uint256 public constant EMERGENCY_TIMEOUT = 15 days;
    
    /// @dev Default timeout in seconds for proposals (1 hour)
    uint256 public constant TIMEOUT_SECONDS = 3600;
    
    /// @dev Maximum number of authorized addresses to prevent gas limit issues
    uint256 public constant MAX_AUTHORIZED_ADDRESSES = 50;
    
    /// @dev Events for proposal lifecycle tracking
    event ProposalIdGenerated(bytes32 indexed proposalId, address indexed generator, uint256 nonce);
    event ProposalCreated(bytes32 indexed proposalId, address indexed creator, uint40 deadline);
    event ProposalApproved(bytes32 indexed proposalId, address indexed approver, uint8 approvalCount);
    event ProposalExecuted(bytes32 indexed proposalId);
    
    /// @dev Events for liquidity tank operations
    event TransferExecuted(address indexed token, address indexed to, uint256 amount);
    event OwnersRotated(address[] oldOwners, address[] newOwners);
    event EmergencyWithdrawal(address indexed token, address indexed to, uint256 amount);
    event EmergencyRecoveryTriggered(address indexed deployer, address[] newOwners);
    event ContractPaused(address indexed by);
    event ContractUnpaused(address indexed by);
    
    /// @dev Events for role management tracking
    event AuthorizationGranted(address indexed account, address indexed grantor);
    event AuthorizationRevoked(address indexed account, address indexed revoker);
    
    /// @dev Modifier to restrict access to authorized addresses only
    modifier onlyAuthorized() {
        if (!isAuthorized[msg.sender]) revert NotAuthorized();
        _;
    }
    
    /// @dev Modifier to restrict access to deployer only
    modifier onlyDeployer() {
        if (msg.sender != deployer) revert NotDeployer();
        _;
    }
    
    /// @dev Modifier to prevent execution when contract is paused
    modifier whenNotPaused() {
        if (paused) revert ContractPausedError();
        _;
    }
    
    /// @dev Custom reentrancy guard - gas efficient implementation (saves ~2k gas vs OpenZeppelin)
    modifier nonReentrant() {
        if (_reentrancyLocked) revert ReentrancyGuard();
        _reentrancyLocked = true;
        _;
        _reentrancyLocked = false;
    }
    
    /// @notice Initialize the contract with deployer and set initial timestamp
    /// @dev Sets deployer for emergency recovery and initializes rotation timer
    constructor() {
        deployer = msg.sender;
        lastOwnershipRotation = block.timestamp;
    }
    
    /// @notice Set the authorized addresses that can approve proposals (one-time setup by deployer)
    /// @param _addresses Array of addresses to authorize (minimum 3 required)
    /// @dev Can only be called once by the deployer for initial setup
    function setAuthorizedAddresses(address[] memory _addresses) external onlyDeployer whenNotPaused {
        if (initialized) revert AlreadyInitialized();
        if (_addresses.length < 3) revert InsufficientAddresses();
        if (_addresses.length > MAX_AUTHORIZED_ADDRESSES) revert TooManyAddresses();
        
        // Validate addresses and check for duplicates (optimized for gas)
        for (uint256 i = 0; i < _addresses.length;) {
            address addr = _addresses[i];
            if (addr == address(0)) revert InvalidAddress();
            if (addr == deployer) revert DeployerCannotBeAuthorized();
            
            // Check for duplicates - more gas efficient with early termination
            for (uint256 j = i + 1; j < _addresses.length;) {
                if (addr == _addresses[j]) revert DuplicateAddress();
                unchecked { ++j; }
            }
            unchecked { ++i; }
        }
        
        // Set new authorizations
        authorizedAddresses = _addresses;
        authorizedCount = uint8(_addresses.length);
        
        uint256 newLength = _addresses.length;
        for (uint256 i = 0; i < newLength;) {
            isAuthorized[_addresses[i]] = true;
            emit AuthorizationGranted(_addresses[i], msg.sender);
            unchecked { ++i; }
        }
        
        initialized = true;
        lastOwnershipRotation = block.timestamp;
    }
    
    /// @notice Emergency recovery function for when multisig becomes inactive
    /// @param _addresses New authorized addresses to set
    /// @dev Can only be called by deployer if 15+ days have passed since last ownership rotation
    function emergencyResetOwners(address[] memory _addresses) external onlyDeployer {
        if (!initialized) revert NotInitialized();
        if (block.timestamp < lastOwnershipRotation + EMERGENCY_TIMEOUT) revert EmergencyTimeoutNotReached();
        if (_addresses.length < 3) revert InsufficientAddresses();
        if (_addresses.length > MAX_AUTHORIZED_ADDRESSES) revert TooManyAddresses();
        
        // Validate new addresses (optimized for gas)
        for (uint256 i = 0; i < _addresses.length;) {
            address addr = _addresses[i];
            if (addr == address(0)) revert InvalidAddress();
            if (addr == deployer) revert DeployerCannotBeAuthorized();
            
            // Check for duplicates - more gas efficient with early termination
            for (uint256 j = i + 1; j < _addresses.length;) {
                if (addr == _addresses[j]) revert DuplicateAddress();
                unchecked { ++j; }
            }
            unchecked { ++i; }
        }
        
        address[] memory oldOwners = authorizedAddresses;
        
        // Clear existing authorizations with proper event tracking
        uint256 currentLength = authorizedAddresses.length;
        for (uint256 i = 0; i < currentLength;) {
            address oldOwner = authorizedAddresses[i];
            isAuthorized[oldOwner] = false;
            emit AuthorizationRevoked(oldOwner, msg.sender);
            unchecked { ++i; }
        }
        
        // Set new authorizations with proper event tracking
        authorizedAddresses = _addresses;
        authorizedCount = uint8(_addresses.length);
        
        uint256 newLength = _addresses.length;
        for (uint256 i = 0; i < newLength;) {
            isAuthorized[_addresses[i]] = true;
            emit AuthorizationGranted(_addresses[i], msg.sender);
            unchecked { ++i; }
        }
        
        lastOwnershipRotation = block.timestamp;
        emit EmergencyRecoveryTriggered(deployer, _addresses);
        emit OwnersRotated(oldOwners, _addresses);
    }
    
    /// @notice Calculate required approvals for 2/3 majority
    /// @return Number of approvals needed (always at least 2)
    /// @dev Uses ceiling division: (2 * n + 2) / 3
    function _calculateRequiredApprovals() internal view returns (uint8) {
        return uint8((2 * uint256(authorizedCount) + 2) / 3);
    }

    
    /// @notice Get the status of a proposal
    /// @param proposalId The proposal to check
    /// @return approvalCount Current number of approvals
    /// @return deadline Unix timestamp when proposal expires
    /// @return executed Whether proposal has been executed
    /// @return expired Whether proposal has expired
    function checkProposalStatus(bytes32 proposalId) external view returns (
        uint8 approvalCount,
        uint40 deadline,
        bool executed,
        bool expired
    ) {
        MultisigProposal storage proposal = proposals[proposalId];
        return (
            proposal.approvalCount,
            proposal.deadline,
            proposal.executed,
            block.timestamp > proposal.deadline
        );
    }
    
    /// @notice Check if an address has approved a specific proposal
    /// @param proposalId The proposal to check
    /// @param addr The address to check
    /// @return Whether the address has approved the proposal
    function hasApproved(bytes32 proposalId, address addr) external view returns (bool) {
        return proposals[proposalId].approvals[addr];
    }
    
    /// @notice Get the number of required approvals for current configuration
    /// @return Number of approvals needed for execution
    function getRequiredApprovals() external view returns (uint8) {
        return _calculateRequiredApprovals();
    }
    
    /// @notice Pause contract operations (emergency only)
    /// @dev Only deployer can pause contract in emergency situations
    function pause() external onlyDeployer {
        paused = true;
        emit ContractPaused(msg.sender);
    }
    
    /// @notice Unpause contract operations  
    /// @dev Only deployer can unpause contract
    function unpause() external onlyDeployer {
        paused = false;
        emit ContractUnpaused(msg.sender);
    }
    
    /// @notice Generate a unique proposal ID using nonce
    /// @return proposalId Unique bytes32 identifier for proposals
    function generateProposalId() external returns (bytes32 proposalId) {
        uint256 currentNonce = proposalNonce++;
        proposalId = keccak256(abi.encodePacked(block.timestamp, msg.sender, currentNonce));
        emit ProposalIdGenerated(proposalId, msg.sender, currentNonce);
    }
    
    // ===========================================================================================
    // LIQUIDITY TANK SPECIFIC FUNCTIONS
    // ===========================================================================================
    
    /// @notice Universal transfer function for ETH and any ERC20 token (requires multisig approval)
    /// @param proposalId Unique identifier for this transfer proposal  
    /// @param token Token contract address (address(0) for ETH)
    /// @param to Recipient address
    /// @param amount Amount to transfer
    /// @dev Each authorized address must call this function to approve the transfer.
    ///      Supports native ETH and any ERC20 token with minimal gas overhead.
    function multisigTransfer(
        bytes32 proposalId,
        address token,
        address to,
        uint256 amount
    ) external onlyAuthorized whenNotPaused nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        
        // Encode transfer parameters for proposal data
        bytes memory data = abi.encode("TRANSFER", token, to, amount);
        
        MultisigProposal storage proposal = proposals[proposalId];
        
        // Initialize proposal on first call
        if (proposal.deadline == 0) {
            proposal.deadline = uint40(block.timestamp + TIMEOUT_SECONDS);
            proposal.data = data;
            emit ProposalCreated(proposalId, msg.sender, proposal.deadline);
        } else {
            // Verify proposal data matches (prevent proposal hijacking)
            if (keccak256(proposal.data) != keccak256(data)) revert ProposalDataMismatch();
        }
        
        // Standard multisig validation
        if (block.timestamp > proposal.deadline) revert ProposalExpired();
        if (proposal.executed) revert AlreadyExecuted();
        if (proposal.approvals[msg.sender]) revert AlreadyApproved();
        
        // Record approval
        proposal.approvals[msg.sender] = true;
        uint8 newApprovalCount = ++proposal.approvalCount;
        
        emit ProposalApproved(proposalId, msg.sender, newApprovalCount);
        
        // Execute if threshold reached
        uint8 requiredApprovals = _calculateRequiredApprovals();
        if (newApprovalCount >= requiredApprovals) {
            proposal.executed = true;
            _executeTransfer(/*proposalId, */ proposal.data);
            emit ProposalExecuted(proposalId);
        }
    }
    
    /// @notice Propose new owners for rotating co-ownership (requires multisig approval)
    /// @param proposalId Unique identifier for this ownership change proposal  
    /// @param newOwners Array of new authorized addresses
    /// @dev Each current authorized address must call this function to approve the rotation.
    ///      Current owners CANNOT set themselves as new owners - enforces true rotation.
    ///      Automatically handled by external blockchain systems.
    function proposeNextOwners(
        bytes32 proposalId,
        address[] calldata newOwners
    ) external onlyAuthorized whenNotPaused {
        if (newOwners.length < 3) revert InsufficientAddresses();
        if (newOwners.length > MAX_AUTHORIZED_ADDRESSES) revert TooManyAddresses();
        
        // Validate new owners (optimized for gas)
        for (uint256 i = 0; i < newOwners.length;) {
            address newOwner = newOwners[i];
            if (newOwner == address(0)) revert InvalidAddress();
            if (newOwner == deployer) revert DeployerCannotBeAuthorized();
            
            // Prevent current authorized addresses from setting themselves
            if (isAuthorized[newOwner]) revert CurrentOwnerCannotBeNewOwner();
            
            // Check for duplicates - more gas efficient with early termination
            for (uint256 j = i + 1; j < newOwners.length;) {
                if (newOwner == newOwners[j]) revert DuplicateAddress();
                unchecked { ++j; }
            }
            unchecked { ++i; }
        }
        
        // Encode ownership change parameters
        bytes memory data = abi.encode("ROTATE_OWNERS", newOwners);
        
        MultisigProposal storage proposal = proposals[proposalId];
        
        // Initialize proposal on first call
        if (proposal.deadline == 0) {
            proposal.deadline = uint40(block.timestamp + TIMEOUT_SECONDS);
            proposal.data = data;
            emit ProposalCreated(proposalId, msg.sender, proposal.deadline);
        } else {
            // Verify proposal data matches
            if (keccak256(proposal.data) != keccak256(data)) revert ProposalDataMismatch();
        }
        
        // Standard multisig validation
        if (block.timestamp > proposal.deadline) revert ProposalExpired();
        if (proposal.executed) revert AlreadyExecuted();
        if (proposal.approvals[msg.sender]) revert AlreadyApproved();
        
        // Record approval
        proposal.approvals[msg.sender] = true;
        uint8 newApprovalCount = ++proposal.approvalCount;
        
        emit ProposalApproved(proposalId, msg.sender, newApprovalCount);
        
        // Execute if threshold reached
        uint8 requiredApprovals = _calculateRequiredApprovals();
        if (newApprovalCount >= requiredApprovals) {
            proposal.executed = true;
            _executeOwnershipRotation(/*proposalId, */ proposal.data);
            emit ProposalExecuted(proposalId);
        }
    }
    
    /// @notice Internal function to execute approved transfers
    /// @param data Encoded transfer parameters
    function _executeTransfer(/*bytes32  proposalId, */ bytes memory data) internal {
        (string memory action, address token, address to, uint256 amount) = 
            abi.decode(data, (string, address, address, uint256));
        
        if (keccak256(bytes(action)) != keccak256("TRANSFER")) revert InvalidAction();
        
        if (token == address(0)) {
            // Transfer ETH
            if (address(this).balance < amount) revert InsufficientBalance();
            (bool success, ) = payable(to).call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            // Transfer ERC20 token using minimal interface
            _safeERC20Transfer(token, to, amount);
        }
        
        emit TransferExecuted(token, to, amount);
    }
    
    /// @notice Internal function to execute ownership rotation
    /// @param data Encoded new owners array
    function _executeOwnershipRotation(/*bytes32 proposalId, */ bytes memory data) internal {
        (string memory action, address[] memory newOwners) = 
            abi.decode(data, (string, address[]));
        
        if (keccak256(bytes(action)) != keccak256("ROTATE_OWNERS")) revert InvalidAction();
        
        address[] memory oldOwners = authorizedAddresses;
        
        // Clear existing authorizations with proper event tracking
        uint256 currentLength = authorizedAddresses.length;
        for (uint256 i = 0; i < currentLength;) {
            address oldOwner = authorizedAddresses[i];
            isAuthorized[oldOwner] = false;
            emit AuthorizationRevoked(oldOwner, address(this)); // Contract itself is the executor
            unchecked { ++i; }
        }
        
        // Set new authorizations with proper event tracking
        authorizedAddresses = newOwners;
        authorizedCount = uint8(newOwners.length);
        
        uint256 newLength = newOwners.length;
        for (uint256 i = 0; i < newLength;) {
            isAuthorized[newOwners[i]] = true;
            emit AuthorizationGranted(newOwners[i], address(this)); // Contract itself is the executor
            unchecked { ++i; }
        }
        
        emit OwnersRotated(oldOwners, newOwners);
        lastOwnershipRotation = block.timestamp;
    }
    
    /// @notice Emergency withdrawal function (requires multisig)
    /// @param proposalId Unique identifier for emergency withdrawal
    /// @param token Token to withdraw (address(0) for ETH)
    /// @param to Emergency recipient address
    /// @param amount Amount to withdraw
    function emergencyWithdraw(
        bytes32 proposalId,
        address token,
        address to,
        uint256 amount
    ) external onlyAuthorized whenNotPaused nonReentrant {
        if (to == address(0)) revert InvalidAddress();
        if (amount == 0) revert InvalidAmount();
        
        bytes memory data = abi.encode("EMERGENCY", token, to, amount);
        
        MultisigProposal storage proposal = proposals[proposalId];
        
        if (proposal.deadline == 0) {
            proposal.deadline = uint40(block.timestamp + TIMEOUT_SECONDS);
            proposal.data = data;
            emit ProposalCreated(proposalId, msg.sender, proposal.deadline);
        } else {
            if (keccak256(proposal.data) != keccak256(data)) revert ProposalDataMismatch();
        }
        
        if (block.timestamp > proposal.deadline) revert ProposalExpired();
        if (proposal.executed) revert AlreadyExecuted();
        if (proposal.approvals[msg.sender]) revert AlreadyApproved();
        
        proposal.approvals[msg.sender] = true;
        uint8 newApprovalCount = ++proposal.approvalCount;
        
        emit ProposalApproved(proposalId, msg.sender, newApprovalCount);
        
        uint8 requiredApprovals = _calculateRequiredApprovals();
        if (newApprovalCount >= requiredApprovals) {
            proposal.executed = true;
            _executeEmergencyWithdraw(proposalId, proposal.data);
            emit ProposalExecuted(proposalId);
        }
    }
    
    /// @notice Internal function for emergency withdrawals
    /// @param data Encoded emergency withdrawal parameters
    function _executeEmergencyWithdraw(bytes32 /* proposalId */, bytes memory data) internal {
        (string memory action, address token, address to, uint256 amount) = 
            abi.decode(data, (string, address, address, uint256));
        
        if (keccak256(bytes(action)) != keccak256("EMERGENCY")) revert InvalidAction();
        
        if (token == address(0)) {
            (bool success, ) = payable(to).call{value: amount}("");
            if (!success) revert TransferFailed();
        } else {
            _safeERC20Transfer(token, to, amount);
        }
        
        emit EmergencyWithdrawal(token, to, amount);
    }
    
    /// @notice Get contract balances
    /// @param token Token address (address(0) for ETH)
    /// @return Current balance
    function getBalance(address token) external view returns (uint256) {
        if (token == address(0)) {
            return address(this).balance;
        } else {
            return _getERC20Balance(token, address(this));
        }
    }
    
    /// @notice Receive ETH deposits
    receive() external payable {}
    
    /// @notice Fallback for ETH deposits
    fallback() external payable {}
    
    // ===========================================================================================
    // MINIMAL ERC20 IMPLEMENTATION FOR GAS EFFICIENCY 
    // ===========================================================================================
    
    /// @notice Safe ERC20 transfer with minimal gas overhead
    /// @param token ERC20 token contract address
    /// @param to Recipient address
    /// @param amount Amount to transfer
    /// @dev Uses low-level call to avoid importing OpenZeppelin - saves significant gas
    function _safeERC20Transfer(address token, address to, uint256 amount) internal {
        // Check balance first to provide better error message
        uint256 balance = _getERC20Balance(token, address(this));
        if (balance < amount) revert InsufficientBalance();
        
        // Prepare transfer call: transfer(address,uint256)
        bytes memory data = abi.encodeWithSelector(0xa9059cbb, to, amount);
        
        // Execute the call
        (bool success, bytes memory returndata) = token.call(data);
        
        // Check if call succeeded and returned true (or nothing for some tokens)
        if (!success || (returndata.length > 0 && !abi.decode(returndata, (bool)))) {
            revert TransferFailed();
        }
    }
    
    /// @notice Get ERC20 token balance with minimal gas overhead
    /// @param token ERC20 token contract address  
    /// @param account Address to check balance for
    /// @return balance Token balance
    /// @dev Uses low-level call to avoid importing interfaces
    function _getERC20Balance(address token, address account) internal view returns (uint256 balance) {
        // Prepare balanceOf call: balanceOf(address)
        bytes memory data = abi.encodeWithSelector(0x70a08231, account);
        
        // Execute the call
        (bool success, bytes memory returndata) = token.staticcall(data);
        
        // Decode result or return 0 if call failed
        if (success && returndata.length >= 32) {
            balance = abi.decode(returndata, (uint256));
        }
        // If call failed or returned invalid data, balance remains 0
    }
}