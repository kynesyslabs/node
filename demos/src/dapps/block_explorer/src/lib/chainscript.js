//THIS FILE CONTAINS NOCODE DATA FOR CROSSCHAIN TRANSACTION

//!!chains
const chains = [
    {
        id:"btc",
        label:"Bitcoin",
        is_evm:false,
        token:"BTC",
        icon:"/crypto-icons/btc.svg",
    },
    {
        id:"eth",
        label:"Ethereum",
        is_evm:true,
        token:"ETH",
        icon:"/crypto-icons/eth.svg",
    },
    {
        id:"xrpl",
        label:"XRP Ledger",
        is_evm:false,
        token:"XRP",
        icon:"/crypto-icons/xrp.svg"
    },
    {
        id:"xlm",
        label:"Stellar Lumens",
        is_evm:false,
        token:"XLM",
        icon:"/crypto-icons/xlm.svg"
    },
    {
        id:"egld",
        label:"MultiversX",
        is_evm:false,
        token:"EGLD",
        icon:"/crypto-icons/egld.svg"
    },
]

const tasks = [
    //pay
    {
        id:"pay",
        label:"Pay",
        constraints:[],
        icon:"fa-paper-plane",
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
    },
    //read contract
    {
        id:"contract_read",
        label:"Read Contract",
        constraints:["evm"],
        icon:"fa-glasses",
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
    //write contract
    {
        id:"contract_write",
        label:"Write Contract",
        constraints:["evm"],
        icon:"fa-feather",
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