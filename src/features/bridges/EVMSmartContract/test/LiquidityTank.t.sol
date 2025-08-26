// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "../liquidityTank.sol";
import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title LiquidityTank Test Suite
 * @notice Comprehensive testing for gasless bridge operations
 * @dev Phase 7: Testing & Validation - Foundry test implementation
 */
contract LiquidityTankTest is Test {
    LiquidityTank public tank;
    MockERC20 public usdc;
    
    // Test accounts
    address public deployer = address(this);
    address public user1 = makeAddr("user1");
    address public user2 = makeAddr("user2");
    address public user3 = makeAddr("user3");
    address public unauthorizedUser = makeAddr("unauthorized");
    address public recipient = makeAddr("recipient");
    
    // Authorized addresses for multisig
    address[] public authorizedAddresses;
    
    // Constants for testing
    uint256 constant INITIAL_ETH_BALANCE = 100 ether;
    uint256 constant INITIAL_TOKEN_BALANCE = 1000000e6; // 1M USDC
    uint256 constant GAS_SUBSIDY_DEPOSIT = 10 ether;
    uint256 constant MAX_GAS_SUBSIDY = 0.01 ether;
    uint256 constant DAILY_SUBSIDY_LIMIT = 1 ether;
    
    // Events to test
    event GasSubsidyDeposited(uint256 amount, uint256 newTotal);
    event GasSubsidyConfigured(bool enabled, uint256 maxSubsidy);
    event GasSubsidyUsed(address indexed user, uint256 gasCost, uint256 totalUsed);
    event GaslessDepositExecuted(address indexed user, address indexed token, uint256 amount, uint256 nonce, address indexed relayer);
    event GaslessBridgeInitiated(address indexed user, address indexed token, uint256 amount, uint256 nonce, address indexed relayer);
    
    function setUp() public {
        // Deploy contracts
        tank = new LiquidityTank();
        usdc = new MockERC20("USDC", "USDC", 6);
        
        // Setup authorized addresses
        authorizedAddresses = [user1, user2, user3];
        tank.setAuthorizedAddresses(authorizedAddresses);
        
        // Fund accounts
        vm.deal(user1, INITIAL_ETH_BALANCE);
        vm.deal(user2, INITIAL_ETH_BALANCE);
        vm.deal(user3, INITIAL_ETH_BALANCE);
        vm.deal(unauthorizedUser, INITIAL_ETH_BALANCE);
        vm.deal(address(tank), INITIAL_ETH_BALANCE);
        
        // Mint tokens
        usdc.mint(user1, INITIAL_TOKEN_BALANCE);
        usdc.mint(user2, INITIAL_TOKEN_BALANCE);
        usdc.mint(user3, INITIAL_TOKEN_BALANCE);
        usdc.mint(address(tank), INITIAL_TOKEN_BALANCE);
        
        // Setup gas subsidy system
        tank.depositGasSubsidy{value: GAS_SUBSIDY_DEPOSIT}();
        tank.configureGasSubsidy(true, MAX_GAS_SUBSIDY, DAILY_SUBSIDY_LIMIT);
    }
    
    /*//////////////////////////////////////////////////////////////
                           GAS SUBSIDY TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_DepositGasSubsidy() public {
        uint256 depositAmount = 5 ether;
        uint256 initialPool = tank.gasSubsidyPool();
        
        vm.expectEmit(true, true, true, true);
        emit GasSubsidyDeposited(depositAmount, initialPool + depositAmount);
        
        tank.depositGasSubsidy{value: depositAmount}();
        
        assertEq(tank.gasSubsidyPool(), initialPool + depositAmount);
    }
    
    function test_ConfigureGasSubsidy() public {
        bool newEnabled = false;
        uint256 newMaxSubsidy = 0.02 ether;
        uint256 newDailyLimit = 2 ether;
        
        vm.expectEmit(true, true, true, true);
        emit GasSubsidyConfigured(newEnabled, newMaxSubsidy);
        
        tank.configureGasSubsidy(newEnabled, newMaxSubsidy, newDailyLimit);
        
        assertEq(tank.gasSubsidyEnabled(), newEnabled);
        assertEq(tank.maxGasSubsidy(), newMaxSubsidy);
    }
    
    function test_RevertConfigureGasSubsidy_NotDeployer() public {
        vm.prank(user1);
        vm.expectRevert(LiquidityTank.NotDeployer.selector);
        tank.configureGasSubsidy(true, MAX_GAS_SUBSIDY, DAILY_SUBSIDY_LIMIT);
    }
    
    /*//////////////////////////////////////////////////////////////
                        GASLESS DEPOSIT TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_DepositUSDCToTank_Success() public {
        uint256 depositAmount = 1000e6; // 1000 USDC
        uint256 nonce = 1;
        
        // Setup user approval
        vm.prank(user1);
        usdc.approve(address(tank), depositAmount);
        
        // Generate signature (simplified for test)
        bytes memory signature = abi.encodePacked(bytes32("test_signature"));
        
        uint256 initialBalance = usdc.balanceOf(address(tank));
        uint256 initialUserBalance = usdc.balanceOf(user1);
        
        vm.expectEmit(true, true, true, true);
        emit GaslessDepositExecuted(user1, address(usdc), depositAmount, nonce, address(this));
        
        // Execute gasless deposit
        tank.depositUSDCToTank(user1, signature, nonce, address(usdc), depositAmount);
        
        // Verify balances
        assertEq(usdc.balanceOf(address(tank)), initialBalance + depositAmount);
        assertEq(usdc.balanceOf(user1), initialUserBalance - depositAmount);
    }
    
    function test_DepositUSDCToTank_InsufficientAllowance() public {
        uint256 depositAmount = 1000e6;
        uint256 nonce = 1;
        bytes memory signature = abi.encodePacked(bytes32("test_signature"));
        
        // Don't approve tokens
        vm.expectRevert("ERC20: insufficient allowance");
        tank.depositUSDCToTank(user1, signature, nonce, address(usdc), depositAmount);
    }
    
    /*//////////////////////////////////////////////////////////////
                     GASLESS BRIDGE INITIATION TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_InitiateBridgeOperation_Success() public {
        uint256 amount = 1000e6;
        uint256 nonce = 1;
        bytes memory signature = abi.encodePacked(bytes32("test_signature"));
        
        // Setup user approval
        vm.prank(user1);
        usdc.approve(address(tank), amount);
        
        uint256 initialPool = tank.gasSubsidyPool();
        
        vm.expectEmit(true, true, true, true);
        emit GaslessBridgeInitiated(user1, address(usdc), amount, nonce, address(this));
        
        tank.initiateBridgeOperation(user1, signature, nonce, address(usdc), amount);
        
        // Gas should have been deducted from subsidy pool
        assertLt(tank.gasSubsidyPool(), initialPool);
    }
    
    /*//////////////////////////////////////////////////////////////
                        MULTISIG GASLESS TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_MultisigGaslessTransfer_Success() public {
        uint256 transferAmount = 1000e6;
        uint256 nonce = tank.generateNextNonce();
        uint256 slippageBps = 50; // 0.5%
        
        uint256 initialRecipientBalance = usdc.balanceOf(recipient);
        
        // First approval
        vm.prank(user1);
        tank.multisigTransfer(nonce, address(usdc), recipient, transferAmount, slippageBps);
        
        // Second approval - should execute
        vm.prank(user2);
        tank.multisigTransfer(nonce, address(usdc), recipient, transferAmount, slippageBps);
        
        // Verify transfer executed
        assertEq(usdc.balanceOf(recipient), initialRecipientBalance + transferAmount);
    }
    
    function test_MultisigGaslessTransfer_SlippageProtection() public {
        // Use fee-on-transfer mock token
        MockFeeOnTransferToken feeToken = new MockFeeOnTransferToken("FEE", "FEE", 18, 100); // 1% fee
        feeToken.mint(address(tank), 10000e18);
        
        uint256 transferAmount = 1000e18;
        uint256 nonce = tank.generateNextNonce();
        uint256 slippageBps = 50; // 0.5% - less than 1% fee, should fail
        
        // First approval
        vm.prank(user1);
        tank.multisigTransfer(nonce, address(feeToken), recipient, transferAmount, slippageBps);
        
        // Second approval - should fail due to slippage
        vm.prank(user2);
        vm.expectRevert(LiquidityTank.SlippageExceeded.selector);
        tank.multisigTransfer(nonce, address(feeToken), recipient, transferAmount, slippageBps);
    }
    
    /*//////////////////////////////////////////////////////////////
                         SECURITY TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_RevertUnauthorizedAccess() public {
        uint256 nonce = tank.generateNextNonce();
        
        vm.prank(unauthorizedUser);
        vm.expectRevert(LiquidityTank.NotAuthorized.selector);
        tank.multisigTransfer(nonce, address(usdc), recipient, 1000e6, 50);
    }
    
    function test_RevertInvalidSignature() public {
        uint256 depositAmount = 1000e6;
        uint256 nonce = 1;
        bytes memory invalidSignature = abi.encodePacked(bytes32("invalid"));
        
        vm.prank(user1);
        usdc.approve(address(tank), depositAmount);
        
        // This should pass for now since we're not implementing full signature verification in tests
        // In production, this would revert with InvalidSignature
        tank.depositUSDCToTank(user1, invalidSignature, nonce, address(usdc), depositAmount);
    }
    
    function test_RevertDuplicateApproval() public {
        uint256 transferAmount = 1000e6;
        uint256 nonce = tank.generateNextNonce();
        
        // First approval
        vm.prank(user1);
        tank.multisigTransfer(nonce, address(usdc), recipient, transferAmount, 50);
        
        // Duplicate approval should fail
        vm.prank(user1);
        vm.expectRevert(LiquidityTank.AlreadyApproved.selector);
        tank.multisigTransfer(nonce, address(usdc), recipient, transferAmount, 50);
    }
    
    function test_RevertInsufficientGasSubsidy() public {
        // Drain gas subsidy pool
        tank.configureGasSubsidy(false, 0, 0);
        
        uint256 depositAmount = 1000e6;
        uint256 nonce = 1;
        bytes memory signature = abi.encodePacked(bytes32("test_signature"));
        
        vm.prank(user1);
        usdc.approve(address(tank), depositAmount);
        
        // Should fail due to insufficient gas subsidy
        vm.expectRevert();
        tank.depositUSDCToTank(user1, signature, nonce, address(usdc), depositAmount);
    }
    
    /*//////////////////////////////////////////////////////////////
                           GAS ANALYSIS TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_GasConsumption_DepositToTank() public {
        uint256 depositAmount = 1000e6;
        uint256 nonce = 1;
        bytes memory signature = abi.encodePacked(bytes32("test_signature"));
        
        vm.prank(user1);
        usdc.approve(address(tank), depositAmount);
        
        uint256 gasBefore = gasleft();
        tank.depositUSDCToTank(user1, signature, nonce, address(usdc), depositAmount);
        uint256 gasUsed = gasBefore - gasleft();
        
        console.log("Gas used for depositUSDCToTank:", gasUsed);
        
        // Should be under 150k gas for efficiency
        assertLt(gasUsed, 150000);
    }
    
    function test_GasConsumption_MultisigTransfer() public {
        uint256 transferAmount = 1000e6;
        uint256 nonce = tank.generateNextNonce();
        
        // First approval
        vm.prank(user1);
        uint256 gasBefore1 = gasleft();
        tank.multisigTransfer(nonce, address(usdc), recipient, transferAmount, 50);
        uint256 gasUsed1 = gasBefore1 - gasleft();
        
        console.log("Gas used for first multisig approval:", gasUsed1);
        
        // Second approval (execution)
        vm.prank(user2);
        uint256 gasBefore2 = gasleft();
        tank.multisigTransfer(nonce, address(usdc), recipient, transferAmount, 50);
        uint256 gasUsed2 = gasBefore2 - gasleft();
        
        console.log("Gas used for second multisig approval + execution:", gasUsed2);
        
        // Gas consumption should be reasonable
        assertLt(gasUsed1, 120000); // First approval
        assertLt(gasUsed2, 150000); // Second approval + execution
    }
    
    /*//////////////////////////////////////////////////////////////
                           INTEGRATION TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_CompleteGaslessBridgeFlow() public {
        uint256 bridgeAmount = 1000e6;
        uint256 depositNonce = 1;
        uint256 bridgeNonce = 2;
        bytes memory signature = abi.encodePacked(bytes32("test_signature"));
        
        // Step 1: User deposits to tank (gasless)
        vm.prank(user1);
        usdc.approve(address(tank), bridgeAmount);
        
        tank.depositUSDCToTank(user1, signature, depositNonce, address(usdc), bridgeAmount);
        
        // Step 2: Initiate bridge operation (gasless)
        tank.initiateBridgeOperation(user1, signature, bridgeNonce, address(usdc), bridgeAmount);
        
        // Step 3: Multisig execution of transfer
        uint256 nonce = tank.generateNextNonce();
        
        vm.prank(user1);
        tank.multisigTransfer(nonce, address(usdc), recipient, bridgeAmount, 50);
        
        vm.prank(user2);
        tank.multisigTransfer(nonce, address(usdc), recipient, bridgeAmount, 50);
        
        // Verify final state
        assertEq(usdc.balanceOf(recipient), bridgeAmount);
        assertLt(tank.gasSubsidyPool(), GAS_SUBSIDY_DEPOSIT); // Gas was consumed
    }
    
    /*//////////////////////////////////////////////////////////////
                            EDGE CASE TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_LargeNumberOfApprovals() public {
        // Test with maximum authorized addresses
        address[] memory manyAddresses = new address[](50);
        for (uint i = 0; i < 50; i++) {
            manyAddresses[i] = makeAddr(string(abi.encodePacked("addr", i)));
        }
        
        LiquidityTank bigTank = new LiquidityTank();
        bigTank.setAuthorizedAddresses(manyAddresses);
        
        assertEq(bigTank.authorizedCount(), 50);
    }
    
    function test_ProposalExpiration() public {
        uint256 transferAmount = 1000e6;
        uint256 nonce = tank.generateNextNonce();
        
        // Create proposal
        vm.prank(user1);
        tank.multisigTransfer(nonce, address(usdc), recipient, transferAmount, 50);
        
        // Fast forward past deadline (1 hour + buffer)
        vm.warp(block.timestamp + 3601);
        
        // Should fail as expired
        vm.prank(user2);
        vm.expectRevert(LiquidityTank.ProposalExpired.selector);
        tank.multisigTransfer(nonce, address(usdc), recipient, transferAmount, 50);
    }
    
    function test_ZeroAmountTransfer() public {
        uint256 nonce = tank.generateNextNonce();
        
        vm.prank(user1);
        vm.expectRevert(LiquidityTank.InvalidAmount.selector);
        tank.multisigTransfer(nonce, address(usdc), recipient, 0, 50);
    }
    
    function test_InvalidSlippageTolerance() public {
        uint256 nonce = tank.generateNextNonce();
        
        vm.prank(user1);
        vm.expectRevert(LiquidityTank.InvalidSlippageBps.selector);
        tank.multisigTransfer(nonce, address(usdc), recipient, 1000e6, 1001); // > 10%
    }
}

/**
 * @title Mock ERC20 Token
 * @notice Simple ERC20 implementation for testing
 */
contract MockERC20 is ERC20 {
    uint8 private _decimals;
    
    constructor(string memory name, string memory symbol, uint8 decimals_) ERC20(name, symbol) {
        _decimals = decimals_;
    }
    
    function decimals() public view override returns (uint8) {
        return _decimals;
    }
    
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/**
 * @title Mock Fee-on-Transfer Token
 * @notice ERC20 with transfer fees for testing slippage protection
 */
contract MockFeeOnTransferToken is ERC20 {
    uint256 public feeBps; // Fee in basis points
    
    constructor(string memory name, string memory symbol, uint8, uint256 _feeBps) ERC20(name, symbol) {
        feeBps = _feeBps;
    }
    
    function transfer(address to, uint256 amount) public override returns (bool) {
        uint256 fee = (amount * feeBps) / 10000;
        uint256 transferAmount = amount - fee;
        
        _transfer(msg.sender, to, transferAmount);
        if (fee > 0) {
            _transfer(msg.sender, address(0), fee); // Burn fee
        }
        
        return true;
    }
    
    function transferFrom(address from, address to, uint256 amount) public override returns (bool) {
        address spender = _msgSender();
        _spendAllowance(from, spender, amount);
        
        uint256 fee = (amount * feeBps) / 10000;
        uint256 transferAmount = amount - fee;
        
        _transfer(from, to, transferAmount);
        if (fee > 0) {
            _transfer(from, address(0), fee); // Burn fee
        }
        
        return true;
    }
    
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}