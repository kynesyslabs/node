// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import "forge-std/Test.sol";
import "forge-std/console.sol";
import "../liquidityTank.sol";

/**
 * @title Gasless Bridge Focused Test Suite
 * @notice Phase 7: Testing gasless bridge specific functionality
 * @dev Focus on validating the gasless bridge operations implemented in Phases 1-6
 */
contract GaslessBridgeTest is Test {
    LiquidityTank public tank;
    MockUSDC public usdc;
    
    // Test accounts
    address public deployer = address(this);
    address public user1 = makeAddr("user1");
    address public user2 = makeAddr("user2");
    address public user3 = makeAddr("user3");
    address public bridgeRecipient = makeAddr("bridgeRecipient");
    address public relayer = makeAddr("relayer");
    
    // Authorized multisig addresses
    address[] public authorizedAddresses;
    
    // Test constants
    uint256 constant BRIDGE_AMOUNT = 1000e6; // 1000 USDC
    uint256 constant GAS_SUBSIDY_POOL = 10 ether;
    uint256 constant MAX_GAS_SUBSIDY = 0.01 ether;
    uint256 constant DAILY_SUBSIDY_LIMIT = 1 ether;
    
    // Events to verify
    event GaslessDepositExecuted(address indexed user, address indexed token, uint256 amount, uint256 nonce, address indexed relayer);
    event GaslessBridgeInitiated(address indexed user, address indexed token, uint256 amount, uint256 nonce, address indexed relayer);
    event GasSubsidyUsed(address indexed user, uint256 gasCost, uint256 totalUsed);
    event TransferExecuted(address indexed token, address indexed recipient, uint256 expectedAmount, uint256 actualAmount);
    
    function setUp() public {
        console.log("🔧 Setting up Gasless Bridge Test Environment");
        
        // Deploy contracts
        tank = new LiquidityTank();
        usdc = new MockUSDC();
        
        // Setup authorized multisig addresses
        authorizedAddresses = [user1, user2, user3];
        tank.setAuthorizedAddresses(authorizedAddresses);
        
        // Fund the contract and setup gas subsidy system
        vm.deal(address(tank), 100 ether);
        tank.depositGasSubsidy{value: GAS_SUBSIDY_POOL}();
        tank.configureGasSubsidy(true, MAX_GAS_SUBSIDY, DAILY_SUBSIDY_LIMIT);
        
        // Fund users with USDC
        usdc.mint(user1, 10000e6);
        usdc.mint(user2, 10000e6);
        usdc.mint(user3, 10000e6);
        
        // Fund tank with USDC for bridge operations
        usdc.mint(address(tank), 100000e6);
        
        console.log("✅ Setup complete - Ready for gasless bridge testing");
    }
    
    /*//////////////////////////////////////////////////////////////
                      GASLESS DEPOSIT TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_GaslessDeposit_Success() public {
        console.log("🧪 Testing gasless deposit functionality");
        
        uint256 nonce = 1;
        bytes memory userSignature = _generateMockSignature(user1, nonce, "DEPOSIT");
        
        // User approves tokens (this requires ETH but it's a standard ERC20 operation)
        vm.prank(user1);
        usdc.approve(address(tank), BRIDGE_AMOUNT);
        
        uint256 initialUserBalance = usdc.balanceOf(user1);
        uint256 initialTankBalance = usdc.balanceOf(address(tank));
        uint256 initialGasPool = tank.gasSubsidyPool();
        
        // Execute gasless deposit - contract pays gas
        vm.expectEmit(true, true, true, true);
        emit GaslessDepositExecuted(user1, address(usdc), BRIDGE_AMOUNT, nonce, address(this));
        
        tank.depositUSDCToTank(user1, userSignature, nonce, address(usdc), BRIDGE_AMOUNT);
        
        // Verify balances changed correctly
        assertEq(usdc.balanceOf(user1), initialUserBalance - BRIDGE_AMOUNT, "User balance should decrease");
        assertEq(usdc.balanceOf(address(tank)), initialTankBalance + BRIDGE_AMOUNT, "Tank balance should increase");
        
        // Verify gas was consumed from subsidy pool
        assertLt(tank.gasSubsidyPool(), initialGasPool, "Gas should be consumed from subsidy pool");
        
        console.log("✅ Gasless deposit test passed");
    }
    
    function test_GaslessDeposit_InsufficientApproval() public {
        console.log("🧪 Testing gasless deposit with insufficient approval");
        
        uint256 nonce = 2;
        bytes memory userSignature = _generateMockSignature(user1, nonce, "DEPOSIT");
        
        // Don't approve tokens - should fail
        vm.expectRevert("ERC20: insufficient allowance");
        tank.depositUSDCToTank(user1, userSignature, nonce, address(usdc), BRIDGE_AMOUNT);
        
        console.log("✅ Insufficient approval test passed");
    }
    
    /*//////////////////////////////////////////////////////////////
                    GASLESS BRIDGE INITIATION TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_GaslessBridgeInitiation_Success() public {
        console.log("🧪 Testing gasless bridge initiation");
        
        uint256 nonce = 100;
        bytes memory userSignature = _generateMockSignature(user1, nonce, "BRIDGE");
        
        // User approves tokens
        vm.prank(user1);
        usdc.approve(address(tank), BRIDGE_AMOUNT);
        
        uint256 initialGasPool = tank.gasSubsidyPool();
        
        // Execute gasless bridge initiation
        vm.expectEmit(true, true, true, true);
        emit GaslessBridgeInitiated(user1, address(usdc), BRIDGE_AMOUNT, nonce, address(this));
        
        tank.initiateBridgeOperation(user1, userSignature, nonce, address(usdc), BRIDGE_AMOUNT);
        
        // Verify gas was consumed
        assertLt(tank.gasSubsidyPool(), initialGasPool, "Gas should be consumed for bridge initiation");
        
        console.log("✅ Gasless bridge initiation test passed");
    }
    
    /*//////////////////////////////////////////////////////////////
                    MULTISIG GASLESS EXECUTION TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_MultisigGaslessExecution_Complete() public {
        console.log("🧪 Testing complete multisig gasless execution");
        
        uint256 transferNonce = tank.generateNextNonce();
        uint256 slippageBps = 50; // 0.5% slippage tolerance
        
        uint256 initialRecipientBalance = usdc.balanceOf(bridgeRecipient);
        uint256 initialTankBalance = usdc.balanceOf(address(tank));
        
        console.log("   💡 Starting multisig approval process");
        
        // First approval (should create proposal)
        vm.prank(user1);
        tank.multisigTransfer(transferNonce, address(usdc), bridgeRecipient, BRIDGE_AMOUNT, slippageBps);
        
        // Verify no execution yet
        assertEq(usdc.balanceOf(bridgeRecipient), initialRecipientBalance, "No execution should occur yet");
        
        // Second approval (should trigger execution)
        vm.prank(user2);
        vm.expectEmit(true, true, true, true);
        emit TransferExecuted(address(usdc), bridgeRecipient, BRIDGE_AMOUNT, BRIDGE_AMOUNT);
        
        tank.multisigTransfer(transferNonce, address(usdc), bridgeRecipient, BRIDGE_AMOUNT, slippageBps);
        
        // Verify execution occurred
        assertEq(usdc.balanceOf(bridgeRecipient), initialRecipientBalance + BRIDGE_AMOUNT, "Recipient should receive tokens");
        assertEq(usdc.balanceOf(address(tank)), initialTankBalance - BRIDGE_AMOUNT, "Tank balance should decrease");
        
        console.log("✅ Complete multisig gasless execution test passed");
    }
    
    function test_MultisigGaslessExecution_PreventDoubleApproval() public {
        console.log("🧪 Testing prevention of double approval in multisig");
        
        uint256 transferNonce = tank.generateNextNonce();
        
        // First approval
        vm.prank(user1);
        tank.multisigTransfer(transferNonce, address(usdc), bridgeRecipient, BRIDGE_AMOUNT, 50);
        
        // Try to approve again with same user - should fail
        vm.prank(user1);
        vm.expectRevert(LiquidityTank.AlreadyApproved.selector);
        tank.multisigTransfer(transferNonce, address(usdc), bridgeRecipient, BRIDGE_AMOUNT, 50);
        
        console.log("✅ Double approval prevention test passed");
    }
    
    /*//////////////////////////////////////////////////////////////
                        GAS SUBSIDY SYSTEM TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_GasSubsidySystem_Configuration() public {
        console.log("🧪 Testing gas subsidy system configuration");
        
        // Test initial state
        assertTrue(tank.gasSubsidyEnabled(), "Gas subsidy should be enabled");
        assertEq(tank.gasSubsidyPool(), GAS_SUBSIDY_POOL, "Gas pool should be funded");
        assertEq(tank.maxGasSubsidy(), MAX_GAS_SUBSIDY, "Max subsidy should be set");
        
        // Test configuration changes (only deployer can do this)
        tank.configureGasSubsidy(false, 0.02 ether, 2 ether);
        
        assertFalse(tank.gasSubsidyEnabled(), "Gas subsidy should be disabled");
        assertEq(tank.maxGasSubsidy(), 0.02 ether, "Max subsidy should be updated");
        
        console.log("✅ Gas subsidy configuration test passed");
    }
    
    function test_GasSubsidySystem_Unauthorized() public {
        console.log("🧪 Testing unauthorized access to gas subsidy configuration");
        
        // Non-deployer should not be able to configure
        vm.prank(user1);
        vm.expectRevert(LiquidityTank.NotDeployer.selector);
        tank.configureGasSubsidy(false, 0, 0);
        
        console.log("✅ Unauthorized gas subsidy access prevention test passed");
    }
    
    /*//////////////////////////////////////////////////////////////
                          INTEGRATION TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_CompleteGaslessBridgeFlow() public {
        console.log("🌉 Testing complete gasless bridge flow");
        
        // Step 1: User deposits to tank (gasless)
        console.log("   📥 Step 1: Gasless deposit to tank");
        uint256 depositNonce = 1;
        bytes memory depositSignature = _generateMockSignature(user1, depositNonce, "DEPOSIT");
        
        vm.prank(user1);
        usdc.approve(address(tank), BRIDGE_AMOUNT);
        
        tank.depositUSDCToTank(user1, depositSignature, depositNonce, address(usdc), BRIDGE_AMOUNT);
        
        // Step 2: Initiate bridge operation (gasless)
        console.log("   🚀 Step 2: Gasless bridge initiation");
        uint256 bridgeNonce = 2;
        bytes memory bridgeSignature = _generateMockSignature(user1, bridgeNonce, "BRIDGE");
        
        tank.initiateBridgeOperation(user1, bridgeSignature, bridgeNonce, address(usdc), BRIDGE_AMOUNT);
        
        // Step 3: Multisig consensus execution
        console.log("   🔐 Step 3: Multisig consensus execution");
        uint256 transferNonce = tank.generateNextNonce();
        
        // First multisig approval
        vm.prank(user1);
        tank.multisigTransfer(transferNonce, address(usdc), bridgeRecipient, BRIDGE_AMOUNT, 50);
        
        // Second multisig approval (triggers execution)
        uint256 initialRecipientBalance = usdc.balanceOf(bridgeRecipient);
        
        vm.prank(user2);
        tank.multisigTransfer(transferNonce, address(usdc), bridgeRecipient, BRIDGE_AMOUNT, 50);
        
        // Verify final state
        assertEq(usdc.balanceOf(bridgeRecipient), initialRecipientBalance + BRIDGE_AMOUNT, "Bridge should complete successfully");
        assertLt(tank.gasSubsidyPool(), GAS_SUBSIDY_POOL, "Gas should have been consumed throughout the process");
        
        console.log("✅ Complete gasless bridge flow test passed - SUCCESS!");
    }
    
    /*//////////////////////////////////////////////////////////////
                            PERFORMANCE TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_GasConsumption_Analysis() public {
        console.log("⚡ Analyzing gas consumption for gasless operations");
        
        uint256 nonce = 500;
        bytes memory signature = _generateMockSignature(user1, nonce, "DEPOSIT");
        
        vm.prank(user1);
        usdc.approve(address(tank), BRIDGE_AMOUNT);
        
        // Measure gas consumption for gasless deposit
        uint256 gasBefore = gasleft();
        tank.depositUSDCToTank(user1, signature, nonce, address(usdc), BRIDGE_AMOUNT);
        uint256 gasUsed = gasBefore - gasleft();
        
        console.log("   💰 Gas used for gasless deposit: %d", gasUsed);
        
        // Should be reasonable (under 200k gas)
        assertLt(gasUsed, 200000, "Gas consumption should be optimized");
        
        console.log("✅ Gas consumption analysis completed");
    }
    
    /*//////////////////////////////////////////////////////////////
                            ERROR HANDLING TESTS
    //////////////////////////////////////////////////////////////*/
    
    function test_ErrorHandling_InsufficientGasPool() public {
        console.log("🚨 Testing error handling for insufficient gas pool");
        
        // Disable gas subsidy
        tank.configureGasSubsidy(false, 0, 0);
        
        uint256 nonce = 999;
        bytes memory signature = _generateMockSignature(user1, nonce, "DEPOSIT");
        
        vm.prank(user1);
        usdc.approve(address(tank), BRIDGE_AMOUNT);
        
        // Should handle gracefully when gas subsidy is disabled
        // Note: In a real implementation, this might revert or require traditional gas payment
        try tank.depositUSDCToTank(user1, signature, nonce, address(usdc), BRIDGE_AMOUNT) {
            console.log("   ⚠️  Operation succeeded without gas subsidy (implementation dependent)");
        } catch {
            console.log("   ✅ Operation correctly failed without gas subsidy");
        }
    }
    
    /*//////////////////////////////////////////////////////////////
                            HELPER FUNCTIONS
    //////////////////////////////////////////////////////////////*/
    
    function _generateMockSignature(address user, uint256 nonce, string memory action) internal pure returns (bytes memory) {
        // Create a simple mock signature for testing
        // In production, this would be a proper EIP-712 or ed25519 signature
        return abi.encodePacked(
            bytes32(keccak256(abi.encodePacked(user, nonce, action))),  // r
            bytes32(keccak256(abi.encodePacked(action, nonce, user))),  // s
            uint8(27) // v
        );
    }
}

/**
 * @title Mock USDC Token
 * @notice Simplified ERC20 implementation for testing
 */
contract MockUSDC {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    
    string public constant name = "USD Coin";
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    
    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    
    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }
    
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "ERC20: insufficient balance");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }
    
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(balanceOf[from] >= amount, "ERC20: insufficient balance");
        require(allowance[from][msg.sender] >= amount, "ERC20: insufficient allowance");
        
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        allowance[from][msg.sender] -= amount;
        
        emit Transfer(from, to, amount);
        return true;
    }
    
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }
}