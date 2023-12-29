# DEMOS Local SDK

## Multichain / Crosschain

You can find all the supported chains by running
    console.log(multichain)
As multichain is exported from multichain/ folder which exports all the supported chains

### Interoperability

Every chain implements the basic class and interface for a blockchain (defaultChain.ts).
In addition to this, EVM chains implements the IEVM specifications (defaultChain.ts) to provide easy access to specific EVM methods.

### Built-in functions

Even with the standardization of the chain interface and class, some operations are way more efficient if executed from a pre-built example.
That's why in crosschain.ts the Crosschain class provides some pre-built functions aggregating the various chains to execute an operation.

### The defaultChain.ts file

In the defaultChain.ts file we can find various classes and interfaces that acts as a standardized implementation of one or more chains. You can peek into the file to see the correct usage of a chain object.
