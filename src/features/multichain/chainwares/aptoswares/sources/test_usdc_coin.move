module my_addrx::TestUSDC {
    use std::string;
    use std::signer;
    use aptos_framework::coin::{Self, Coin, MintCapability, BurnCapability};

    /// Test USDC coin type for demo purposes
    struct TestUSDC has key {}

    /// Capabilities for minting and burning
    struct Capabilities has key {
        mint_cap: MintCapability<TestUSDC>,
        burn_cap: BurnCapability<TestUSDC>,
    }

    /// Initialize the test USDC coin
    public entry fun initialize(account: &signer) {
        let (burn_cap, freeze_cap, mint_cap) = coin::initialize<TestUSDC>(
            account,
            string::utf8(b"Test USDC"),
            string::utf8(b"TUSDC"),
            6, // 6 decimals like real USDC
            true, // monitor supply
        );

        // Destroy freeze capability as we don't need it
        coin::destroy_freeze_cap(freeze_cap);

        // Store mint and burn capabilities
        move_to(account, Capabilities {
            mint_cap,
            burn_cap,
        });
    }

    /// Mint test USDC (only resource account can do this)
    public entry fun mint(account: &signer, dst_addr: address, amount: u64) acquires Capabilities {
        let account_addr = signer::address_of(account);
        assert!(exists<Capabilities>(account_addr), 1);

        let capabilities = borrow_global<Capabilities>(account_addr);
        let coins = coin::mint(amount, &capabilities.mint_cap);
        coin::deposit(dst_addr, coins);
    }

    /// Register an account to receive test USDC
    public entry fun register(account: &signer) {
        coin::register<TestUSDC>(account);
    }

    /// Transfer test USDC between accounts
    public entry fun transfer(from: &signer, to: address, amount: u64) {
        coin::transfer<TestUSDC>(from, to, amount);
    }

    /// Get balance of an account
    public fun balance(owner: address): u64 {
        coin::balance<TestUSDC>(owner)
    }
}