/**
 * Program IDL in camelCase format in order to be used in JS/TS.
 *
 * Note that this is only a type helper and is not the actual IDL. The original
 * IDL can be found at `target/idl/uns_sol.json`.
 */
export type UnsSol = {
  "address": "6eLvwb1dwtV5coME517Ki53DojQaRLUctY9qHqAsS9G2",
  "metadata": {
    "name": "unsSol",
    "version": "0.1.0",
    "spec": "0.1.0",
    "description": "Created with Anchor"
  },
  "instructions": [
    {
      "name": "addMinter",
      "discriminator": [
        75,
        86,
        218,
        40,
        219,
        6,
        141,
        29
      ],
      "accounts": [
        {
          "name": "minterPda",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "minter"
              }
            ]
          }
        },
        {
          "name": "minter"
        },
        {
          "name": "programAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "authoritySigner",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": []
    },
    {
      "name": "addRecord",
      "discriminator": [
        65,
        186,
        219,
        131,
        44,
        66,
        61,
        216
      ],
      "accounts": [
        {
          "name": "recordPda",
          "writable": true
        },
        {
          "name": "sldMint"
        },
        {
          "name": "domainProperties",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  100,
                  111,
                  109,
                  97,
                  105,
                  110,
                  95,
                  112,
                  114,
                  111,
                  112,
                  101,
                  114,
                  116,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "sldMint"
              }
            ]
          }
        },
        {
          "name": "ata",
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "ataOwner"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "sldMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ataOwner",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "recordKey",
          "type": "string"
        },
        {
          "name": "value",
          "type": "string"
        }
      ]
    },
    {
      "name": "addRecordBeforeMint",
      "discriminator": [
        62,
        57,
        203,
        191,
        182,
        36,
        55,
        227
      ],
      "accounts": [
        {
          "name": "recordPda",
          "writable": true
        },
        {
          "name": "sldMint"
        },
        {
          "name": "minterPda",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "minter"
              }
            ]
          }
        },
        {
          "name": "minter",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "recordKey",
          "type": "string"
        },
        {
          "name": "value",
          "type": "string"
        }
      ]
    },
    {
      "name": "createTld",
      "discriminator": [
        216,
        213,
        126,
        50,
        156,
        194,
        18,
        83
      ],
      "accounts": [
        {
          "name": "tld",
          "writable": true
        },
        {
          "name": "programAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "authoritySigner",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "label",
          "type": "string"
        },
        {
          "name": "isExpirable",
          "type": "bool"
        }
      ]
    },
    {
      "name": "initialize",
      "discriminator": [
        175,
        175,
        109,
        31,
        13,
        152,
        155,
        237
      ],
      "accounts": [
        {
          "name": "programAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "authority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "mintSld",
      "discriminator": [
        152,
        18,
        50,
        213,
        45,
        11,
        111,
        104
      ],
      "accounts": [
        {
          "name": "sldMint",
          "writable": true
        },
        {
          "name": "tokenAccount",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "user"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "sldMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "tld"
        },
        {
          "name": "domainProperties",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  100,
                  111,
                  109,
                  97,
                  105,
                  110,
                  95,
                  112,
                  114,
                  111,
                  112,
                  101,
                  114,
                  116,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "sldMint"
              }
            ]
          }
        },
        {
          "name": "extraAccountMetaList",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "sldMint"
              }
            ]
          }
        },
        {
          "name": "user"
        },
        {
          "name": "minterPda",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "minter"
              }
            ]
          }
        },
        {
          "name": "minter",
          "writable": true,
          "signer": true
        },
        {
          "name": "programAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "associatedTokenProgram",
          "address": "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "tldLabel",
          "type": "string"
        },
        {
          "name": "label",
          "type": "string"
        },
        {
          "name": "expiration",
          "type": "u64"
        },
        {
          "name": "metadataUri",
          "type": "string"
        }
      ]
    },
    {
      "name": "removeMinter",
      "discriminator": [
        241,
        69,
        84,
        16,
        164,
        232,
        131,
        79
      ],
      "accounts": [
        {
          "name": "minterPda",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "minter"
              }
            ]
          }
        },
        {
          "name": "minter"
        },
        {
          "name": "programAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "authoritySigner",
          "signer": true
        },
        {
          "name": "refundReceiver",
          "writable": true
        }
      ],
      "args": []
    },
    {
      "name": "removeRecord",
      "discriminator": [
        57,
        165,
        122,
        26,
        131,
        148,
        234,
        99
      ],
      "accounts": [
        {
          "name": "recordPda",
          "writable": true
        },
        {
          "name": "sldMint"
        },
        {
          "name": "domainProperties",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  100,
                  111,
                  109,
                  97,
                  105,
                  110,
                  95,
                  112,
                  114,
                  111,
                  112,
                  101,
                  114,
                  116,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "sldMint"
              }
            ]
          }
        },
        {
          "name": "ata",
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "ataOwner"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "sldMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ataOwner",
          "signer": true
        },
        {
          "name": "minterPda",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "refundReceiver"
              }
            ]
          }
        },
        {
          "name": "refundReceiver",
          "writable": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "recordKey",
          "type": "string"
        }
      ]
    },
    {
      "name": "removeRecordBeforeMint",
      "discriminator": [
        174,
        193,
        102,
        17,
        111,
        131,
        144,
        29
      ],
      "accounts": [
        {
          "name": "recordPda",
          "writable": true
        },
        {
          "name": "sldMint"
        },
        {
          "name": "minterPda",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "minter"
              }
            ]
          }
        },
        {
          "name": "minter",
          "signer": true
        },
        {
          "name": "refundReceiver",
          "writable": true
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "recordKey",
          "type": "string"
        }
      ]
    },
    {
      "name": "removeTld",
      "discriminator": [
        117,
        218,
        124,
        196,
        193,
        44,
        131,
        232
      ],
      "accounts": [
        {
          "name": "tld",
          "writable": true
        },
        {
          "name": "programAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "authoritySigner",
          "signer": true
        },
        {
          "name": "refundReceiver",
          "writable": true
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "label",
          "type": "string"
        }
      ]
    },
    {
      "name": "setExpiration",
      "discriminator": [
        17,
        250,
        26,
        178,
        132,
        169,
        26,
        51
      ],
      "accounts": [
        {
          "name": "domainProperties",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  100,
                  111,
                  109,
                  97,
                  105,
                  110,
                  95,
                  112,
                  114,
                  111,
                  112,
                  101,
                  114,
                  116,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "sldMint"
              }
            ]
          }
        },
        {
          "name": "sldMint"
        },
        {
          "name": "minterPda",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "minter"
              }
            ]
          }
        },
        {
          "name": "minter",
          "signer": true
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "newExpiration",
          "type": "u64"
        }
      ]
    },
    {
      "name": "transferHook",
      "discriminator": [
        105,
        37,
        101,
        197,
        75,
        251,
        102,
        26
      ],
      "accounts": [
        {
          "name": "sourceToken"
        },
        {
          "name": "mint"
        },
        {
          "name": "destinationToken"
        },
        {
          "name": "owner"
        },
        {
          "name": "extraAccountMetaList",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  101,
                  120,
                  116,
                  114,
                  97,
                  45,
                  97,
                  99,
                  99,
                  111,
                  117,
                  110,
                  116,
                  45,
                  109,
                  101,
                  116,
                  97,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "domainProperties",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  100,
                  111,
                  109,
                  97,
                  105,
                  110,
                  95,
                  112,
                  114,
                  111,
                  112,
                  101,
                  114,
                  116,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "mint"
              }
            ]
          }
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "amount",
          "type": "u64"
        }
      ]
    },
    {
      "name": "updateDomainMetadataUrl",
      "discriminator": [
        184,
        226,
        230,
        170,
        30,
        120,
        229,
        9
      ],
      "accounts": [
        {
          "name": "sldMint",
          "writable": true
        },
        {
          "name": "programAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "minterPda",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  109,
                  105,
                  110,
                  116,
                  101,
                  114
                ]
              },
              {
                "kind": "account",
                "path": "minter"
              }
            ]
          }
        },
        {
          "name": "minter",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        }
      ],
      "args": [
        {
          "name": "newMetadataUrl",
          "type": "string"
        }
      ]
    },
    {
      "name": "updateProgramAuthority",
      "discriminator": [
        15,
        214,
        181,
        183,
        136,
        194,
        245,
        18
      ],
      "accounts": [
        {
          "name": "programAuthority",
          "writable": true,
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  112,
                  114,
                  111,
                  103,
                  114,
                  97,
                  109,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "authoritySigner",
          "signer": true
        }
      ],
      "args": [
        {
          "name": "newAuthority",
          "type": "pubkey"
        }
      ]
    },
    {
      "name": "updateRecord",
      "discriminator": [
        54,
        194,
        108,
        162,
        199,
        12,
        5,
        60
      ],
      "accounts": [
        {
          "name": "recordPda",
          "writable": true
        },
        {
          "name": "sldMint"
        },
        {
          "name": "domainProperties",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  1
                ]
              },
              {
                "kind": "const",
                "value": [
                  100,
                  111,
                  109,
                  97,
                  105,
                  110,
                  95,
                  112,
                  114,
                  111,
                  112,
                  101,
                  114,
                  116,
                  105,
                  101,
                  115
                ]
              },
              {
                "kind": "account",
                "path": "sldMint"
              }
            ]
          }
        },
        {
          "name": "ata",
          "pda": {
            "seeds": [
              {
                "kind": "account",
                "path": "ataOwner"
              },
              {
                "kind": "account",
                "path": "tokenProgram"
              },
              {
                "kind": "account",
                "path": "sldMint"
              }
            ],
            "program": {
              "kind": "const",
              "value": [
                140,
                151,
                37,
                143,
                78,
                36,
                137,
                241,
                187,
                61,
                16,
                41,
                20,
                142,
                13,
                131,
                11,
                90,
                19,
                153,
                218,
                255,
                16,
                132,
                4,
                142,
                123,
                216,
                219,
                233,
                248,
                89
              ]
            }
          }
        },
        {
          "name": "ataOwner",
          "signer": true
        },
        {
          "name": "payer",
          "writable": true,
          "signer": true
        },
        {
          "name": "tokenProgram",
          "address": "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        },
        {
          "name": "systemProgram",
          "address": "11111111111111111111111111111111"
        },
        {
          "name": "eventAuthority",
          "pda": {
            "seeds": [
              {
                "kind": "const",
                "value": [
                  95,
                  95,
                  101,
                  118,
                  101,
                  110,
                  116,
                  95,
                  97,
                  117,
                  116,
                  104,
                  111,
                  114,
                  105,
                  116,
                  121
                ]
              }
            ]
          }
        },
        {
          "name": "program"
        }
      ],
      "args": [
        {
          "name": "recordKey",
          "type": "string"
        },
        {
          "name": "value",
          "type": "string"
        }
      ]
    }
  ],
  "accounts": [
    {
      "name": "domainProperties",
      "discriminator": [
        247,
        96,
        98,
        87,
        105,
        137,
        116,
        194
      ]
    },
    {
      "name": "minter",
      "discriminator": [
        28,
        69,
        107,
        166,
        41,
        139,
        205,
        247
      ]
    },
    {
      "name": "programAuthority",
      "discriminator": [
        38,
        198,
        188,
        60,
        171,
        210,
        169,
        38
      ]
    },
    {
      "name": "record",
      "discriminator": [
        254,
        233,
        117,
        252,
        76,
        166,
        146,
        139
      ]
    },
    {
      "name": "tld",
      "discriminator": [
        53,
        129,
        84,
        201,
        157,
        33,
        4,
        97
      ]
    }
  ],
  "events": [
    {
      "name": "domainMinted",
      "discriminator": [
        92,
        202,
        134,
        57,
        185,
        96,
        136,
        58
      ]
    },
    {
      "name": "expirationSet",
      "discriminator": [
        113,
        224,
        108,
        51,
        249,
        235,
        173,
        41
      ]
    },
    {
      "name": "recordAdded",
      "discriminator": [
        220,
        101,
        67,
        16,
        19,
        60,
        90,
        35
      ]
    },
    {
      "name": "recordRemoved",
      "discriminator": [
        26,
        50,
        240,
        190,
        55,
        53,
        183,
        214
      ]
    },
    {
      "name": "recordUpdated",
      "discriminator": [
        22,
        215,
        203,
        119,
        23,
        134,
        237,
        84
      ]
    },
    {
      "name": "tldAdded",
      "discriminator": [
        6,
        18,
        164,
        57,
        6,
        223,
        50,
        6
      ]
    },
    {
      "name": "tldRemoved",
      "discriminator": [
        91,
        19,
        81,
        29,
        244,
        154,
        29,
        208
      ]
    },
    {
      "name": "transfer",
      "discriminator": [
        25,
        18,
        23,
        7,
        172,
        116,
        130,
        28
      ]
    }
  ],
  "errors": [
    {
      "code": 6000,
      "name": "notAProgramAuthority",
      "msg": "Not authorized as program authority"
    },
    {
      "code": 6001,
      "name": "tldDoesNotExist",
      "msg": "TLD does not exist"
    },
    {
      "code": 6002,
      "name": "invalidMintAccountSpace",
      "msg": "Invalid Mint account space for SLD creation"
    },
    {
      "code": 6003,
      "name": "invalidExpiration",
      "msg": "Invalid SLD expiration"
    },
    {
      "code": 6004,
      "name": "domainExpired",
      "msg": "Domain is expired"
    },
    {
      "code": 6005,
      "name": "extraMetaListNotInitialized",
      "msg": "ExtraAccountMetaList is not initialized"
    },
    {
      "code": 6006,
      "name": "recordTooLong",
      "msg": "Record value is too long"
    },
    {
      "code": 6007,
      "name": "domainAlreadyExists",
      "msg": "Domain already exists"
    },
    {
      "code": 6008,
      "name": "transferFromAuthorityFailed",
      "msg": "Transfer SLD from program authority failed"
    },
    {
      "code": 6009,
      "name": "notADomainOwner",
      "msg": "Not a domain owner"
    },
    {
      "code": 6010,
      "name": "invalidDomainLabel",
      "msg": "Invalid domain label"
    },
    {
      "code": 6011,
      "name": "invalidRecordKey",
      "msg": "Invalid record key"
    },
    {
      "code": 6012,
      "name": "isNotCurrentlyTransferring",
      "msg": "The token is not currently transferring"
    }
  ],
  "types": [
    {
      "name": "domainMinted",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "tldLabel",
            "type": "string"
          },
          {
            "name": "sldLabel",
            "type": "string"
          },
          {
            "name": "owner",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "domainProperties",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "expiration",
            "type": "u64"
          },
          {
            "name": "recordsVersion",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "expirationSet",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "newExpiration",
            "type": "u64"
          }
        ]
      }
    },
    {
      "name": "minter",
      "type": {
        "kind": "struct",
        "fields": []
      }
    },
    {
      "name": "programAuthority",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "authority",
            "type": "pubkey"
          }
        ]
      }
    },
    {
      "name": "record",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "value",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "recordAdded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "key",
            "type": "string"
          },
          {
            "name": "value",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "recordRemoved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "key",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "recordUpdated",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "key",
            "type": "string"
          },
          {
            "name": "newValue",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "tld",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "isExpirable",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "tldAdded",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "label",
            "type": "string"
          },
          {
            "name": "isExpirable",
            "type": "bool"
          }
        ]
      }
    },
    {
      "name": "tldRemoved",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "label",
            "type": "string"
          }
        ]
      }
    },
    {
      "name": "transfer",
      "type": {
        "kind": "struct",
        "fields": [
          {
            "name": "mint",
            "type": "pubkey"
          },
          {
            "name": "from",
            "type": "pubkey"
          },
          {
            "name": "to",
            "type": "pubkey"
          },
          {
            "name": "amount",
            "type": "u64"
          }
        ]
      }
    }
  ]
};
