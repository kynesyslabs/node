module my_addrx::DemosBridgeEscrowEnhanced {
    use std::signer;
    use std::option::{Self, Option};
    use std::table::{Self, Table};
    use std::timestamp;
    use std::error;
    use std::string::{Self, String};
    use std::vector;
    use aptos_framework::coin::{Self, Coin};
    use aptos_framework::event::{Self, EventHandle};
    use aptos_framework::account;
    
    // REVIEW: Enhanced Demos Bridge Escrow with emergency functions and operational limits
    
    const E_NOT_INITIALIZED: u64 = 1;
    const E_ALREADY_INITIALIZED: u64 = 2;
    const E_INSUFFICIENT_LIQUIDITY: u64 = 3;
    const E_BRIDGE_NOT_FOUND: u64 = 4;
    const E_BRIDGE_ALREADY_EXISTS: u64 = 5;
    const E_NOT_AUTHORIZED: u64 = 6;
    const E_BRIDGE_EXPIRED: u64 = 7;
    const E_BRIDGE_ALREADY_COMPLETED: u64 = 8;
    const E_INVALID_TIMEOUT: u64 = 9;
    const E_ZERO_AMOUNT: u64 = 10;
    const E_BRIDGE_NOT_EXPIRED: u64 = 11;
    const E_CONTRACT_PAUSED: u64 = 12;
    const E_AMOUNT_TOO_SMALL: u64 = 13;
    const E_AMOUNT_TOO_LARGE: u64 = 14;
    const E_RATE_LIMIT_EXCEEDED: u64 = 15;
    const E_NOT_OWNER: u64 = 16;

    struct USDC {}

    /// Bridge operation status
    const BRIDGE_STATUS_PENDING: u8 = 1;
    const BRIDGE_STATUS_CONFIRMED: u8 = 2;
    const BRIDGE_STATUS_FAILED: u8 = 3;
    const BRIDGE_STATUS_EXPIRED: u8 = 4;

    /// Operational limits
    struct OperationalLimits has store, copy, drop {
        min_bridge_amount: u64,        // Minimum USDC per bridge
        max_bridge_amount: u64,        // Maximum USDC per bridge  
        max_hourly_volume: u64,        // Maximum USDC per hour
        max_daily_volume: u64,         // Maximum USDC per day
        min_timeout_seconds: u64,      // Minimum bridge timeout
        max_timeout_seconds: u64,      // Maximum bridge timeout
    }

    /// Rate limiting tracking
    struct RateLimitTracker has store {
        hourly_volume: u64,
        daily_volume: u64,
        last_hour_reset: u64,
        last_day_reset: u64,
    }

    /// Bridge operation data structure
    struct BridgeOperation has store, copy, drop {
        bridge_id: vector<u8>,
        user_address: address,
        source_chain: String,
        dest_chain: String,
        source_asset: String,
        dest_asset: String,
        locked_usdc_amount: u64,
        created_timestamp: u64,
        timeout_timestamp: u64,
        status: u8,
    }

    /// Enhanced escrow with emergency functions and limits
    struct BridgeEscrowEnhanced has key {
        /// USDC coin store for the escrow
        usdc_store: Coin<USDC>,
        /// Active bridge operations
        bridge_operations: Table<vector<u8>, BridgeOperation>,
        /// Total amount currently locked in bridges
        total_locked: u64,
        /// Authorized Demos addresses (multisig)
        authorized_addresses: vector<address>,
        /// Contract owner/admin
        owner: address,
        /// Emergency pause state
        is_paused: bool,
        /// Operational limits
        limits: OperationalLimits,
        /// Rate limiting tracker
        rate_tracker: RateLimitTracker,
        /// Fee rate (basis points, e.g., 10 = 0.1%)
        fee_rate_bp: u64,
        /// Collected fees
        collected_fees: u64,
        /// Events
        bridge_initiated_events: EventHandle<BridgeInitiatedEvent>,
        bridge_confirmed_events: EventHandle<BridgeConfirmedEvent>,
        bridge_failed_events: EventHandle<BridgeFailedEvent>,
        bridge_expired_events: EventHandle<BridgeExpiredEvent>,
        liquidity_added_events: EventHandle<LiquidityAddedEvent>,
        liquidity_removed_events: EventHandle<LiquidityRemovedEvent>,
        emergency_events: EventHandle<EmergencyEvent>,
        fee_collected_events: EventHandle<FeeCollectedEvent>,
    }

    /// Event structures
    struct BridgeInitiatedEvent has drop, store {
        bridge_id: vector<u8>,
        user_address: address,
        source_chain: String,
        dest_chain: String,
        locked_amount: u64,
        fee_amount: u64,
        timeout_timestamp: u64,
        timestamp: u64,
    }

    struct BridgeConfirmedEvent has drop, store {
        bridge_id: vector<u8>,
        user_address: address,
        locked_amount: u64,
        timestamp: u64,
    }

    struct BridgeFailedEvent has drop, store {
        bridge_id: vector<u8>,
        user_address: address,
        locked_amount: u64,
        timestamp: u64,
    }

    struct BridgeExpiredEvent has drop, store {
        bridge_id: vector<u8>,
        user_address: address,
        locked_amount: u64,
        timestamp: u64,
    }

    struct LiquidityAddedEvent has drop, store {
        provider: address,
        amount: u64,
        timestamp: u64,
    }

    struct LiquidityRemovedEvent has drop, store {
        recipient: address,
        amount: u64,
        timestamp: u64,
    }

    struct EmergencyEvent has drop, store {
        action: String,
        executor: address,
        amount: Option<u64>,
        timestamp: u64,
    }

    struct FeeCollectedEvent has drop, store {
        bridge_id: vector<u8>,
        fee_amount: u64,
        timestamp: u64,
    }

    /// Initialize the enhanced bridge escrow
    public entry fun initialize(
        owner: &signer, 
        authorized_addresses: vector<address>,
        min_bridge_amount: u64,
        max_bridge_amount: u64,
        max_hourly_volume: u64,
        max_daily_volume: u64,
        fee_rate_bp: u64
    ) {
        let owner_addr = signer::address_of(owner);
        assert!(!exists<BridgeEscrowEnhanced>(owner_addr), error::already_exists(E_ALREADY_INITIALIZED));
        
        let limits = OperationalLimits {
            min_bridge_amount,
            max_bridge_amount,
            max_hourly_volume,
            max_daily_volume,
            min_timeout_seconds: 300,  // 5 minutes minimum
            max_timeout_seconds: 86400, // 24 hours maximum
        };

        let rate_tracker = RateLimitTracker {
            hourly_volume: 0,
            daily_volume: 0,
            last_hour_reset: timestamp::now_seconds(),
            last_day_reset: timestamp::now_seconds(),
        };
        
        let escrow = BridgeEscrowEnhanced {
            usdc_store: coin::zero<USDC>(),
            bridge_operations: table::new<vector<u8>, BridgeOperation>(),
            total_locked: 0,
            authorized_addresses,
            owner: owner_addr,
            is_paused: false,
            limits,
            rate_tracker,
            fee_rate_bp,
            collected_fees: 0,
            bridge_initiated_events: account::new_event_handle<BridgeInitiatedEvent>(owner),
            bridge_confirmed_events: account::new_event_handle<BridgeConfirmedEvent>(owner),
            bridge_failed_events: account::new_event_handle<BridgeFailedEvent>(owner),
            bridge_expired_events: account::new_event_handle<BridgeExpiredEvent>(owner),
            liquidity_added_events: account::new_event_handle<LiquidityAddedEvent>(owner),
            liquidity_removed_events: account::new_event_handle<LiquidityRemovedEvent>(owner),
            emergency_events: account::new_event_handle<EmergencyEvent>(owner),
            fee_collected_events: account::new_event_handle<FeeCollectedEvent>(owner),
        };
        
        move_to(owner, escrow);
    }

    /// Emergency pause (owner only)
    public entry fun emergency_pause(owner: &signer) acquires BridgeEscrowEnhanced {
        let owner_addr = signer::address_of(owner);
        let escrow_addr = get_escrow_address();
        assert!(exists<BridgeEscrowEnhanced>(escrow_addr), error::not_found(E_NOT_INITIALIZED));
        
        let escrow = borrow_global_mut<BridgeEscrowEnhanced>(escrow_addr);
        assert!(escrow.owner == owner_addr, error::permission_denied(E_NOT_OWNER));
        
        escrow.is_paused = true;
        
        event::emit_event(&mut escrow.emergency_events, EmergencyEvent {
            action: string::utf8(b"PAUSE"),
            executor: owner_addr,
            amount: option::none<u64>(),
            timestamp: timestamp::now_seconds(),
        });
    }

    /// Emergency unpause (owner only)
    public entry fun emergency_unpause(owner: &signer) acquires BridgeEscrowEnhanced {
        let owner_addr = signer::address_of(owner);
        let escrow_addr = get_escrow_address();
        assert!(exists<BridgeEscrowEnhanced>(escrow_addr), error::not_found(E_NOT_INITIALIZED));
        
        let escrow = borrow_global_mut<BridgeEscrowEnhanced>(escrow_addr);
        assert!(escrow.owner == owner_addr, error::permission_denied(E_NOT_OWNER));
        
        escrow.is_paused = false;
        
        event::emit_event(&mut escrow.emergency_events, EmergencyEvent {
            action: string::utf8(b"UNPAUSE"),
            executor: owner_addr,
            amount: option::none<u64>(),
            timestamp: timestamp::now_seconds(),
        });
    }

    /// Emergency withdraw (owner only, for extreme situations)
    public entry fun emergency_withdraw(owner: &signer, amount: u64) acquires BridgeEscrowEnhanced {
        let owner_addr = signer::address_of(owner);
        let escrow_addr = get_escrow_address();
        assert!(exists<BridgeEscrowEnhanced>(escrow_addr), error::not_found(E_NOT_INITIALIZED));
        
        let escrow = borrow_global_mut<BridgeEscrowEnhanced>(escrow_addr);
        assert!(escrow.owner == owner_addr, error::permission_denied(E_NOT_OWNER));
        assert!(coin::value(&escrow.usdc_store) >= amount, error::invalid_state(E_INSUFFICIENT_LIQUIDITY));
        
        let withdrawn_coins = coin::extract(&mut escrow.usdc_store, amount);
        coin::deposit(owner_addr, withdrawn_coins);
        
        event::emit_event(&mut escrow.emergency_events, EmergencyEvent {
            action: string::utf8(b"EMERGENCY_WITHDRAW"),
            executor: owner_addr,
            amount: option::some(amount),
            timestamp: timestamp::now_seconds(),
        });
    }

    /// Add authorized address (owner only)
    public entry fun add_authorized_address(owner: &signer, new_address: address) acquires BridgeEscrowEnhanced {
        let owner_addr = signer::address_of(owner);
        let escrow_addr = get_escrow_address();
        assert!(exists<BridgeEscrowEnhanced>(escrow_addr), error::not_found(E_NOT_INITIALIZED));
        
        let escrow = borrow_global_mut<BridgeEscrowEnhanced>(escrow_addr);
        assert!(escrow.owner == owner_addr, error::permission_denied(E_NOT_OWNER));
        
        vector::push_back(&mut escrow.authorized_addresses, new_address);
    }

    /// Remove authorized address (owner only)
    public entry fun remove_authorized_address(owner: &signer, address_to_remove: address) acquires BridgeEscrowEnhanced {
        let owner_addr = signer::address_of(owner);
        let escrow_addr = get_escrow_address();
        assert!(exists<BridgeEscrowEnhanced>(escrow_addr), error::not_found(E_NOT_INITIALIZED));
        
        let escrow = borrow_global_mut<BridgeEscrowEnhanced>(escrow_addr);
        assert!(escrow.owner == owner_addr, error::permission_denied(E_NOT_OWNER));
        
        let (found, index) = vector::index_of(&escrow.authorized_addresses, &address_to_remove);
        if (found) {
            vector::remove(&mut escrow.authorized_addresses, index);
        };
    }

    /// Enhanced bridge initiation with limits and rate limiting
    public entry fun initiate_bridge(
        caller: &signer,
        bridge_id: vector<u8>,
        user_address: address,
        source_chain: vector<u8>,
        dest_chain: vector<u8>,
        source_asset: vector<u8>,
        dest_asset: vector<u8>,
        lock_amount: u64,
        timeout_seconds: u64
    ) acquires BridgeEscrowEnhanced {
        let caller_addr = signer::address_of(caller);
        let escrow_addr = get_escrow_address();
        assert!(exists<BridgeEscrowEnhanced>(escrow_addr), error::not_found(E_NOT_INITIALIZED));
        
        let escrow = borrow_global_mut<BridgeEscrowEnhanced>(escrow_addr);
        assert!(!escrow.is_paused, error::invalid_state(E_CONTRACT_PAUSED));
        assert!(is_authorized(caller_addr, escrow), error::permission_denied(E_NOT_AUTHORIZED));
        
        // Validate operational limits
        assert!(lock_amount >= escrow.limits.min_bridge_amount, error::invalid_argument(E_AMOUNT_TOO_SMALL));
        assert!(lock_amount <= escrow.limits.max_bridge_amount, error::invalid_argument(E_AMOUNT_TOO_LARGE));
        assert!(timeout_seconds >= escrow.limits.min_timeout_seconds, error::invalid_argument(E_INVALID_TIMEOUT));
        assert!(timeout_seconds <= escrow.limits.max_timeout_seconds, error::invalid_argument(E_INVALID_TIMEOUT));
        
        // Check rate limits
        update_and_check_rate_limits(escrow, lock_amount);
        
        // Check if bridge ID already exists
        assert!(!table::contains(&escrow.bridge_operations, bridge_id), 
               error::already_exists(E_BRIDGE_ALREADY_EXISTS));
        
        // Calculate fee
        let fee_amount = (lock_amount * escrow.fee_rate_bp) / 10000;
        let total_required = lock_amount + fee_amount;
        
        // Check if sufficient liquidity is available
        let available_liquidity = coin::value(&escrow.usdc_store) - escrow.total_locked;
        assert!(available_liquidity >= total_required, error::invalid_state(E_INSUFFICIENT_LIQUIDITY));
        
        let current_time = timestamp::now_seconds();
        let timeout_timestamp = current_time + timeout_seconds;
        
        // Create bridge operation
        let bridge_op = BridgeOperation {
            bridge_id,
            user_address,
            source_chain: string::utf8(source_chain),
            dest_chain: string::utf8(dest_chain),
            source_asset: string::utf8(source_asset),
            dest_asset: string::utf8(dest_asset),
            locked_usdc_amount: lock_amount,
            created_timestamp: current_time,
            timeout_timestamp,
            status: BRIDGE_STATUS_PENDING,
        };
        
        // Store bridge operation and update locked amount
        table::add(&mut escrow.bridge_operations, bridge_id, bridge_op);
        escrow.total_locked = escrow.total_locked + lock_amount;
        escrow.collected_fees = escrow.collected_fees + fee_amount;
        
        // Emit events
        event::emit_event(&mut escrow.bridge_initiated_events, BridgeInitiatedEvent {
            bridge_id,
            user_address,
            source_chain: string::utf8(source_chain),
            dest_chain: string::utf8(dest_chain),
            locked_amount: lock_amount,
            fee_amount,
            timeout_timestamp,
            timestamp: current_time,
        });

        if (fee_amount > 0) {
            event::emit_event(&mut escrow.fee_collected_events, FeeCollectedEvent {
                bridge_id,
                fee_amount,
                timestamp: current_time,
            });
        };
    }

    /// Withdraw collected fees (owner only)
    public entry fun withdraw_fees(owner: &signer, amount: u64) acquires BridgeEscrowEnhanced {
        let owner_addr = signer::address_of(owner);
        let escrow_addr = get_escrow_address();
        assert!(exists<BridgeEscrowEnhanced>(escrow_addr), error::not_found(E_NOT_INITIALIZED));
        
        let escrow = borrow_global_mut<BridgeEscrowEnhanced>(escrow_addr);
        assert!(escrow.owner == owner_addr, error::permission_denied(E_NOT_OWNER));
        assert!(escrow.collected_fees >= amount, error::invalid_state(E_INSUFFICIENT_LIQUIDITY));
        
        let fee_coins = coin::extract(&mut escrow.usdc_store, amount);
        coin::deposit(owner_addr, fee_coins);
        escrow.collected_fees = escrow.collected_fees - amount;
    }

    /// Enhanced liquidity stats with fee information
    public fun get_enhanced_stats(): (u64, u64, u64, u64, bool) acquires BridgeEscrowEnhanced {
        let escrow_addr = get_escrow_address();
        if (!exists<BridgeEscrowEnhanced>(escrow_addr)) return (0, 0, 0, 0, true);
        
        let escrow = borrow_global<BridgeEscrowEnhanced>(escrow_addr);
        let total_liquidity = coin::value(&escrow.usdc_store);
        let locked_liquidity = escrow.total_locked;
        let available_liquidity = total_liquidity - locked_liquidity - escrow.collected_fees;
        
        (total_liquidity, locked_liquidity, available_liquidity, escrow.collected_fees, escrow.is_paused)
    }

    /// Update and check rate limits
    fun update_and_check_rate_limits(escrow: &mut BridgeEscrowEnhanced, amount: u64) {
        let current_time = timestamp::now_seconds();
        
        // Reset hourly volume if an hour has passed
        if (current_time >= escrow.rate_tracker.last_hour_reset + 3600) {
            escrow.rate_tracker.hourly_volume = 0;
            escrow.rate_tracker.last_hour_reset = current_time;
        };
        
        // Reset daily volume if a day has passed
        if (current_time >= escrow.rate_tracker.last_day_reset + 86400) {
            escrow.rate_tracker.daily_volume = 0;
            escrow.rate_tracker.last_day_reset = current_time;
        };
        
        // Check rate limits
        assert!(escrow.rate_tracker.hourly_volume + amount <= escrow.limits.max_hourly_volume,
               error::invalid_state(E_RATE_LIMIT_EXCEEDED));
        assert!(escrow.rate_tracker.daily_volume + amount <= escrow.limits.max_daily_volume,
               error::invalid_state(E_RATE_LIMIT_EXCEEDED));
        
        // Update volumes
        escrow.rate_tracker.hourly_volume = escrow.rate_tracker.hourly_volume + amount;
        escrow.rate_tracker.daily_volume = escrow.rate_tracker.daily_volume + amount;
    }

    /// Check if address is authorized
    fun is_authorized(addr: address, escrow: &BridgeEscrowEnhanced): bool {
        if (addr == escrow.owner) return true;
        
        let i = 0;
        let len = vector::length(&escrow.authorized_addresses);
        while (i < len) {
            if (*vector::borrow(&escrow.authorized_addresses, i) == addr) {
                return true
            };
            i = i + 1;
        };
        false
    }

    /// Helper function to get escrow address
    fun get_escrow_address(): address {
        @my_addrx
    }

    /// Add liquidity to the escrow (owner or authorized addresses)
    public entry fun add_liquidity(account: &signer, amount: u64) acquires BridgeEscrowEnhanced {
        assert!(amount > 0, error::invalid_argument(E_ZERO_AMOUNT));
        
        let account_addr = signer::address_of(account);
        let escrow_addr = get_escrow_address();
        assert!(exists<BridgeEscrowEnhanced>(escrow_addr), error::not_found(E_NOT_INITIALIZED));
        
        let escrow = borrow_global_mut<BridgeEscrowEnhanced>(escrow_addr);
        assert!(is_authorized(account_addr, escrow), error::permission_denied(E_NOT_AUTHORIZED));
        
        let added_coins = coin::withdraw<USDC>(account, amount);
        coin::merge(&mut escrow.usdc_store, added_coins);
        
        event::emit_event(&mut escrow.liquidity_added_events, LiquidityAddedEvent {
            provider: account_addr,
            amount,
            timestamp: timestamp::now_seconds(),
        });
    }

    /// Remove liquidity from the escrow (owner only)
    public entry fun remove_liquidity(owner: &signer, amount: u64) acquires BridgeEscrowEnhanced {
        assert!(amount > 0, error::invalid_argument(E_ZERO_AMOUNT));
        
        let owner_addr = signer::address_of(owner);
        let escrow_addr = get_escrow_address();
        assert!(exists<BridgeEscrowEnhanced>(escrow_addr), error::not_found(E_NOT_INITIALIZED));
        
        let escrow = borrow_global_mut<BridgeEscrowEnhanced>(escrow_addr);
        assert!(escrow.owner == owner_addr, error::permission_denied(E_NOT_OWNER));
        
        let available_liquidity = coin::value(&escrow.usdc_store) - escrow.total_locked - escrow.collected_fees;
        assert!(available_liquidity >= amount, error::invalid_state(E_INSUFFICIENT_LIQUIDITY));
        
        let removed_coins = coin::extract(&mut escrow.usdc_store, amount);
        coin::deposit(owner_addr, removed_coins);
        
        event::emit_event(&mut escrow.liquidity_removed_events, LiquidityRemovedEvent {
            recipient: owner_addr,
            amount,
            timestamp: timestamp::now_seconds(),
        });
    }

    /// Confirm successful bridge completion (authorized addresses only)
    public entry fun confirm_bridge(caller: &signer, bridge_id: vector<u8>) acquires BridgeEscrowEnhanced {
        let caller_addr = signer::address_of(caller);
        let escrow_addr = get_escrow_address();
        assert!(exists<BridgeEscrowEnhanced>(escrow_addr), error::not_found(E_NOT_INITIALIZED));
        
        let escrow = borrow_global_mut<BridgeEscrowEnhanced>(escrow_addr);
        assert!(is_authorized(caller_addr, escrow), error::permission_denied(E_NOT_AUTHORIZED));
        
        assert!(table::contains(&escrow.bridge_operations, bridge_id), 
               error::not_found(E_BRIDGE_NOT_FOUND));
        
        let bridge_op = table::borrow_mut(&mut escrow.bridge_operations, bridge_id);
        assert!(bridge_op.status == BRIDGE_STATUS_PENDING, 
               error::invalid_state(E_BRIDGE_ALREADY_COMPLETED));
        
        bridge_op.status = BRIDGE_STATUS_CONFIRMED;
        escrow.total_locked = escrow.total_locked - bridge_op.locked_usdc_amount;
        
        event::emit_event(&mut escrow.bridge_confirmed_events, BridgeConfirmedEvent {
            bridge_id,
            user_address: bridge_op.user_address,
            locked_amount: bridge_op.locked_usdc_amount,
            timestamp: timestamp::now_seconds(),
        });
    }

    /// Mark bridge as failed (authorized addresses only)
    public entry fun fail_bridge(caller: &signer, bridge_id: vector<u8>) acquires BridgeEscrowEnhanced {
        let caller_addr = signer::address_of(caller);
        let escrow_addr = get_escrow_address();
        assert!(exists<BridgeEscrowEnhanced>(escrow_addr), error::not_found(E_NOT_INITIALIZED));
        
        let escrow = borrow_global_mut<BridgeEscrowEnhanced>(escrow_addr);
        assert!(is_authorized(caller_addr, escrow), error::permission_denied(E_NOT_AUTHORIZED));
        
        assert!(table::contains(&escrow.bridge_operations, bridge_id), 
               error::not_found(E_BRIDGE_NOT_FOUND));
        
        let bridge_op = table::borrow_mut(&mut escrow.bridge_operations, bridge_id);
        assert!(bridge_op.status == BRIDGE_STATUS_PENDING, 
               error::invalid_state(E_BRIDGE_ALREADY_COMPLETED));
        
        bridge_op.status = BRIDGE_STATUS_FAILED;
        escrow.total_locked = escrow.total_locked - bridge_op.locked_usdc_amount;
        
        event::emit_event(&mut escrow.bridge_failed_events, BridgeFailedEvent {
            bridge_id,
            user_address: bridge_op.user_address,
            locked_amount: bridge_op.locked_usdc_amount,
            timestamp: timestamp::now_seconds(),
        });
    }

    /// Expire a bridge operation after timeout (callable by anyone)
    public entry fun expire_bridge(_caller: &signer, bridge_id: vector<u8>) acquires BridgeEscrowEnhanced {
        let escrow_addr = get_escrow_address();
        assert!(exists<BridgeEscrowEnhanced>(escrow_addr), error::not_found(E_NOT_INITIALIZED));
        
        let escrow = borrow_global_mut<BridgeEscrowEnhanced>(escrow_addr);
        
        assert!(table::contains(&escrow.bridge_operations, bridge_id), 
               error::not_found(E_BRIDGE_NOT_FOUND));
        
        let bridge_op = table::borrow_mut(&mut escrow.bridge_operations, bridge_id);
        assert!(bridge_op.status == BRIDGE_STATUS_PENDING, 
               error::invalid_state(E_BRIDGE_ALREADY_COMPLETED));
        
        let current_time = timestamp::now_seconds();
        assert!(current_time >= bridge_op.timeout_timestamp, 
               error::invalid_state(E_BRIDGE_NOT_EXPIRED));
        
        bridge_op.status = BRIDGE_STATUS_EXPIRED;
        escrow.total_locked = escrow.total_locked - bridge_op.locked_usdc_amount;
        
        event::emit_event(&mut escrow.bridge_expired_events, BridgeExpiredEvent {
            bridge_id,
            user_address: bridge_op.user_address,
            locked_amount: bridge_op.locked_usdc_amount,
            timestamp: current_time,
        });
    }

    /// Get bridge operation details
    public fun get_bridge_operation(bridge_id: vector<u8>): Option<BridgeOperation> acquires BridgeEscrowEnhanced {
        let escrow_addr = get_escrow_address();
        if (!exists<BridgeEscrowEnhanced>(escrow_addr)) return option::none<BridgeOperation>();
        
        let escrow = borrow_global<BridgeEscrowEnhanced>(escrow_addr);
        
        if (table::contains(&escrow.bridge_operations, bridge_id)) {
            let bridge_op = *table::borrow(&escrow.bridge_operations, bridge_id);
            option::some(bridge_op)
        } else {
            option::none<BridgeOperation>()
        }
    }

    /// Get operational limits
    public fun get_operational_limits(): (u64, u64, u64, u64) acquires BridgeEscrowEnhanced {
        let escrow_addr = get_escrow_address();
        if (!exists<BridgeEscrowEnhanced>(escrow_addr)) return (0, 0, 0, 0);
        
        let escrow = borrow_global<BridgeEscrowEnhanced>(escrow_addr);
        (escrow.limits.min_bridge_amount, escrow.limits.max_bridge_amount, 
         escrow.limits.max_hourly_volume, escrow.limits.max_daily_volume)
    }

    /// Get rate limit status
    public fun get_rate_limit_status(): (u64, u64, u64, u64) acquires BridgeEscrowEnhanced {
        let escrow_addr = get_escrow_address();
        if (!exists<BridgeEscrowEnhanced>(escrow_addr)) return (0, 0, 0, 0);
        
        let escrow = borrow_global<BridgeEscrowEnhanced>(escrow_addr);
        let current_time = timestamp::now_seconds();
        
        (escrow.rate_tracker.hourly_volume, 
         escrow.rate_tracker.daily_volume,
         current_time - escrow.rate_tracker.last_hour_reset,
         current_time - escrow.rate_tracker.last_day_reset)
    }
}