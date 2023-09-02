// INFO Use the src/features/multichain/chainscript/chainscript.chs for the specs
// NOTE This module is meant to be used with the demos websdk


// INFO Using the methods below to create, manage and send chainscript-like scripts
let XMTransactions = {
	schemas: {
		base_operation: {
			chain: "",
			subchain: "",
			is_evm: false,
            rpc: "",
			task: {
				type: "",
				params: {}
			}
		}
	},

	data: {
		// NOTE This is a list of all operations that have been loaded in the current session
		loaded_operations: {},
		operations_index: [], 
	},

	task: {},

	operation: {
		// ANCHOR Setters

		// NOTE Creating and adding a new operation to the current session list
		create: function(name, chain, subchain, is_evm, rpc, task) {
			let operation = XMTransactions.schemas.base_operation;
			operation.chain = chain;
			operation.subchain = subchain;
			operation.is_evm = is_evm;
			operation.rpc = rpc;
			operation.task = task;
			XMTransactions.data.loaded_operations[name] = operation;
			XMTransactions.data.operations_index.push(name);
			return operation;
		},

		// NOTE Deleting an operation from the current session list
		delete: function(name) {
            delete XMTransactions.data.loaded_operations[name];
			let index = XMTransactions.data.operations_index.indexOf(name);
			XMTransactions.data.operations_index.splice(index)
        },

		// NOTE Changing operation order for an operation from the current session list
		reorder: function(name, index) {
            let operation_current = XMTransactions.data.operations_index.indexOf(name);
			// Deleting and...
			XMTransactions.data.operations_index.splice(operation_current, 1);
			//...inserting it at the new index
			XMTransactions.data.operations_index.splice(index, 0, name);
        },

		// NOTE Updating an operation from the current session list
		update: function(name, chain, subchain, is_evm, rpc, task) {
            let operation = XMTransactions.schemas.base_operation;
            operation.chain = chain;
            operation.subchain = subchain;
            operation.is_evm = is_evm;
            operation.rpc = rpc;
            operation.task = task;
            XMTransactions.data.loaded_operations[name] = operation;
        },

		// ANCHOR Getters

		// NOTE Getting all the operations from the current session list
		get: function() {
            return XMTransactions.data.loaded_operations;
        },

        // NOTE Getting an operation from the current session list by name
        get_by_name: function(name) {
            return XMTransactions.data.loaded_operations[name];
        },

		get_ordered_index: function() {
			return XMTransactions.data.operations_index;
        },

	},

}

export default XMTransactions