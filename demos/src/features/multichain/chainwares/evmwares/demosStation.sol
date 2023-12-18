// SPDX-License-Identifier: GPL-3.0
pragma solidity ^0.8.19;

// SECTION DEMOS Primitive Types

// NOTE status_native struct
struct GLSNative {
    uint balance;
    uint nonce;
    // tx_list is not included on chain 
}

// NOTE status_properties components and struct
struct GLSToken {
    address demos_id;
    uint balance;
}

struct GLSNFT {
    address demo_id;
    mapping(uint => uint) balance;
}

struct GLSProperties {
    GLSToken tokens; // TODO Do a struct
    GLSNFT nfts; // TODO Do a struct
}

// NOTE Primitives used outside the database
// Those are used to have a mapped registry of requests
struct GLSRequest {
    bool exists;
    address requestor; // Who is requesting this data?
    bool is_private; // Should this request be private to be consulted?
    string request; // One of the available request types
    uint request_timestamp; // Keepin' track of the request
    string answer; // Empty: answer is fulfilled by the DEMOS Network
    uint answer_timestamp; // Let's ensure integrity
    string answer_source; // DEMOS Address
}
// !SECTION DEMOS Primitive Types

// SECTION DEMOS Composite types
// NOTE DEMOS GLS Representation
// Each address on a chain is linked to an address on DEMOS with the following properties
struct GLS {
    GLSNative native;
    GLSProperties properties;
}

// NOTE DEMOS Ecosystem structure
struct demosState {
    bytes udid; // Unique Demos IDentifier
    uint256 chain; // Chain identifier (see DEMOS network documentation)

    // Mappings to link addresses from here to DEMOS network
    mapping(address => mapping(string => GLS)) addresses;

    // In the following registry are stored the communication variables in order to communicate with the DEMOS network asynchronously
    mapping(uint => GLSRequest) requests;
    // WIP requestsIndex is to be retrieved by the DEMOS Network to be able to quickly sync with demosStation communications
    uint requestsIndex; // Starting with 0
}
// !SECTION DEMOS Composite types



// NOTE This contract ensures security is delivered
contract secure {

    address owner;
    bool isLocked; // Defaults to false

    // Prevent reentrancy by using the isLocked property
    modifier noReentrancy {
        if (isLocked) {
            revert("Reentrant");
        } else {
            _;
        }
    }

    function lock() private {
        isLocked = true;
    }

    function unlock() private {
        isLocked = false;
    }

    // Restrict access to the contract owner
    modifier onlyOwner {
        if (msg.sender == owner) {
            _;
        }
    }

    function setOwner( address new_owner) public onlyOwner {
        owner = new_owner;
    }

}

// TODO WIP onlyDEMOSValidators need to have at least a starting point
// ANCHOR DEMOS Authentication & Authorization contract
contract demosSafeguard {
    mapping(address => bool) public known_validators;
    mapping(address => bool) public slashed_validators;

    // Ensuring only DEMOS Validators are able to access the contract DEMOS Methods
    modifier onlyDEMOSValidators {
        if (!known_validators[msg.sender]) {
            revert ("You are not authorized to do this");
        }
        if (slashed_validators[msg.sender]) {
            revert ("You are not authorized to do this");
        }
        _;
    }

    // NOTE Management section
    function setValidator(address validator) public onlyDEMOSValidators {
        known_validators[validator] = true;
    }

    function slashValidator(address validator) public onlyDEMOSValidators {
        slashed_validators[validator] = true;
    }
}

// ANCHOR Main DEMOS hook contract
contract demosStation is secure, demosSafeguard {
    demosState public state;

    // Basic properties
    string name = "DEMOS Station";

    // By default, deployer is also owner
    constructor(uint chainID) {
        owner = msg.sender;
        // Definition of the demos state
        state.chain = chainID;
        // Computing the udid
        state.udid = abi.encodePacked(block.timestamp, owner, state.chain, blockhash(block.number - 1));
    }

    // SECTION Public view methods
    /*
        INFO Most of the following methods are public as it is assumed that anyone can inspect and query the DEMOS Station
        current state. To ensure that privacy-enabled transactions are implemented in the near future, the following methods
        are subject to changes.
    */
    // Getting the requestIndex to quickly sync with the demosStation communication framework
    function getRequestsIndex() public view returns (uint requestId) {
        return state.requestsIndex;
    }

    // Getting a request given its index (if any)
    function getRequest(uint requestId) public view noReentrancy returns(GLSRequest memory request) {
        if (!state.requests[requestId].exists) {
            revert("Request with that id does not exist");
        }
        // Privacy check
        if (!state.requests[requestId].is_private) {
            if (state.requests[requestId].requestor != msg.sender) {
                revert("Request with that id does not exist"); // Ha ha, jokes on you 
            }
        }
        
        // Returning the request data
        return state.requests[requestId];
    }

    // SECTION Other methods
    // Registering a request to be fulfilled by the DEMOS Network
    function requestFromDEMOS(string memory request) public noReentrancy returns(uint requestId) {
        uint ourId = state.requestsIndex + 1;
        state.requests[ourId].request = request;
        state.requests[ourId].request_timestamp = block.timestamp;
        state.requests[ourId].requestor = msg.sender;
        state.requests[ourId].exists = true;
        return ourId;
    }


    // SECTION DEMOS Exclusive methods
    // WIP Method to register answers from within the DEMOS Network into the host blockchain
    // TODO Swap strings for requests and answers with (probably) bytes so to compress the data as much as possible
    function answerRequest(uint requestId, string memory answer) 
                           public noReentrancy onlyDEMOSValidators 
                           returns(bool success) {
        if (requestId < state.requestsIndex) revert ("Request ID is out of range");
        if (state.requests[requestId].answer_timestamp > 0) revert ("A reply was received for this request");
        state.requests[requestId].answer_timestamp = block.timestamp;
        state.requests[requestId].answer = answer;
        return true;
    }

    
}