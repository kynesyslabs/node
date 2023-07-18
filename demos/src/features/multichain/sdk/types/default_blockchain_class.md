# Default Chain Class for DEMOS SDK

## What is this class?

This is the base class on which all other chain classes are derived

### Properties

Dynamic properties of the chain class

#### provider: any

It is the base to operate on a blockchain in general. It is usually filled at instantiation and it is used in a lot of class functions.

#### wallet: any

Given a Private Key, we can also write on the blockchain. It is usually filled on demand and it is used in a lot of class functions.

### Methods

#### connectWallet(privateKey: string): any;

Fill this.wallet by connecting with a private key to the blockchain

#### getBalance (address: string): Promise<string>

Get the balance of the address on the blockchain

#### sendTransaction (transactions: any): any

Send a transaction on the blockchain, using this.wallet as sender
