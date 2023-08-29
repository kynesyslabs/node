// We have to connect to the two blockchains in order to start
"connect": {
	"chain": "ethereum",
	"subchain": "goerli",
	"is_evm": true,
	"rpc": "https://rpc.ankr.com/eth_goerli",
	"task": {
		"type": "connection",
		"params": {
			"privateKey": "0x123321123321",
		}
	}
}
"connect": {
	"chain": "xrpl",
	"subchain": "testnet",
	"is_evm": false,
	"rpc": "https://s.altnet.rippletest.net",
	"task": {
		"type": "connection",
		"params": {
			"privateKey": "abcdefghijklmnopqrstuvwxyz",
		}
	}
}

// First, we transfer an amount on Goerli just to reward our loyal customer
"transfer_money": {
	"chain": "ethereum",
	"subchain": "goerli",
	"is_evm": true,
	"task": {
		"type": "pay",
        "params": {
			"to": "0x000000000000",	
			"amount": "10000000000000"
		}
	}
}

// Now we can check if our customer still hold our token
"check_a_contract_state": {
	"chain": "ethereum",
    "subchain": "goerli",
    "is_evm": true,
    "task": {
		"type": "contract_read",
        "params": {
			"address": "0x0000000000001",
			"method": "balanceOf",
            "params": [ "0x000000000000" ]
		}
	}	
}

// If they don't hold the token, we will send the token to them
if "check_a_contract_state" == 0 then

    "transfer_token": {
		"chain": "ethereum",
        "subchain": "goerli",
		"is_evm": true,
		"task": {
            "type": "contract_write",
			"params": {
				"address": "0x0000000000001",
                "method": "transfer",
				"params": [ "0x00000000000", "10000000000000" ]
			}
		}
	}

// If they do, we will send some Ripple to them to thanks them even more
else

    "ripple_payment": {
        "chain": "xrpl",
		"subchain": "testnet",
		"is_evm": false,
		"task": {
            "type": "pay",
			"params": {
				"to": "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh",
                "amount": "10000000000000"
            }
		}
	}

// Finally, we convert some of our tokens into Ripple to support payments
"convert_token": {
    "chain": "crosschain",
    "subchain": ["ethereum", "xrpl], // In crosschain operations, many of the previous parameters are couples
    "is_evm": [true, false],
    "rpc": ["https://rpc.ankr.com/eth_goerli", "https://rpc.ankr.com/eth_goerli"],
    "task": {
		"type": "bridge",
		"timeout": "15m", // After 15 minutes, we will give up
        "params": {
			"from": "ethereum",
			"to": "xrpl",
			"in": {
				"type": "token", // This allows DEMOS to automatically convert the token to native currency (e.g. ETH)
				"address": "0x0000000000000",
				"amount": "10000000000000",
			},
			"out": {
                "type": "native", // We want Ripple's native currency
				"address": null, // That has not an address
				"minAmount": "5000" // We don't accept less than this amount
			}
		}
	}
}