## Foundry

**Foundry is a blazing fast, portable and modular toolkit for Ethereum application development written in Rust.**

Foundry consists of:

- **Forge**: Ethereum testing framework (like Truffle, Hardhat and DappTools).
- **Cast**: Swiss army knife for interacting with EVM smart contracts, sending transactions and getting chain data.
- **Anvil**: Local Ethereum node, akin to Ganache, Hardhat Network.
- **Chisel**: Fast, utilitarian, and verbose solidity REPL.

## Documentation

https://book.getfoundry.sh/

## Usage

### Build

```shell
$ forge build
```

### Test

#### Run All Tests
```shell
$ forge test
```

#### Run Specific Test Suite
```shell
# Run gasless bridge tests (6/10 tests passing)
$ forge test --match-contract "GaslessBridgeTest"

# Run specific test function
$ forge test --match-test "test_GaslessDeposit_Success"

# Run with verbose output (-v, -vv, -vvv for increasing verbosity)
$ forge test --match-contract "GaslessBridgeTest" -vv
```

#### Test Status
- **GaslessBridgeTest**: 6/10 tests passing ✅
  - ✅ Gasless deposits with signature verification
  - ✅ Gasless bridge initiation with events  
  - ✅ Gas subsidy system configuration
  - ✅ Error handling for edge cases
  - 🔧 4 tests need minor fixes (multisig consensus, gas optimization)

#### Manual Test Execution
If `forge` is not in your PATH, use the full path:
```shell
$ /home/tcsenpai/.foundry/bin/forge test --match-contract "GaslessBridgeTest"
```

### Format

```shell
$ forge fmt
```

### Gas Snapshots

```shell
$ forge snapshot
```

### Anvil

```shell
$ anvil
```

### Deploy

```shell
$ forge script script/Counter.s.sol:CounterScript --rpc-url <your_rpc_url> --private-key <your_private_key>
```

### Cast

```shell
$ cast <subcommand>
```

### Help

```shell
$ forge --help
$ anvil --help
$ cast --help
```
