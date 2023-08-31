//THIS FILE CONTAINS NOCODE DATA FOR CROSSCHAIN TRANSACTION

//!!chains
const chains = [
    {
        id:"ethereum",
        label:"Ethereum",
        is_evm:true
    },
    {
        id:"xrpl",
        label:"XRP Ledger",
        is_evm:false
    },
    {
        id:"SOL",
        label:"Solana",
        is_evm:false
    },
    {
        id:"DOT",
        label:"Polkadot",
        is_evm:false
    },
    {
        id:"ADA",
        label:"Cardano",
        is_evm:false
    }
]

//!!tasks for single chain operations
    //tasks for all single chains
const universalTasks = [
    {
        id:"pay",
        label:"Pay",
        params:[
            {
                id:"to",
                label:"To",
                type:"address",
                required:true
            },
            {
                id:"amount",
                label:"Amount",
                type:"number",
                required:true
            }
        ]
    }
]

    //tasks for evm chains
const evmTasks = [
    {
        id:"contract_read",
        label:"Read Contract",
        params:[
            {
                id:"address",
                label:"Address",
                type:"address",
                required:true
            },
            {
                id:"abi",
                label:"ABI",
                type:"json",
                required:false
            },
            {
                id:"method",
                label:"Method",
                type:"string",
                required:true
            },
            {
                id:"params",
                label:"Params",
                type:"json",
                required:true
            }
        ] 
    },
];

//!!tasks for multichain operations
const mUniversalTasks = [];
const mEvmTasks = [];

export {chains, universalTasks, evmTasks, mUniversalTasks, mEvmTasks};