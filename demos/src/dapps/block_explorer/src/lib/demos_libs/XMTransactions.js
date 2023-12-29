// INFO Use the src/features/multichain/chainscript/chainscript.chs for the specs
// NOTE This module is meant to be used with the demos websdk

// INFO Using the methods below to create, manage and send chainscript-like scripts
const XMTransactions = {
  schemas: {
    base_operation: {
      chain: '',
      subchain: '',
      is_evm: false,
      rpc: '',
      conditional: false,
      task: {
        type: '',
        params: {},
        signedPayloads: []
      }
    },
    condition_operation: {
      operator: '',
      statement: '',
      callback: '',
      alternative: ''
    }
  },

  data: {
    // NOTE This is a list of all operations that have been loaded in the current session
    loaded_operations: {},
    operations_index: []
  },

  task: {},

  operation: {
    // ANCHOR Setters

    // NOTE Creating and adding a new operation to the current session list
    // megabudino was here: I added the conditional parameter; changed operation.task = task to not overwrite
    create: function (name, chain, subchain, is_evm, rpc, task, conditional = false) {
      // TODO Bugfix: implement a name
      const operation = { ...XMTransactions.schemas.base_operation }
      operation.chain = chain
      operation.subchain = subchain
      operation.is_evm = is_evm
      operation.rpc = rpc
      operation.conditional = conditional
      operation.task = task
      XMTransactions.data.loaded_operations[name] = operation
      XMTransactions.data.operations_index.push(name)
      return operation
    },

    // megabudino was here: this is the function that creates the condition operation
    create_condition: function (name, operator, statement, callback, alternative) {
      const condition = { ...XMTransactions.schemas.condition_operation }
      condition.operator = operator
      condition.statement = statement
      condition.callback = callback
      condition.alternative = alternative
      XMTransactions.data.loaded_operations[name] = condition
      XMTransactions.data.operations_index.push(name)
      return condition
    },

    // megabudino was here: this is the function to push signed payloads to the task
    push_signed_payload: function (name, signed_payload) {
      XMTransactions.data.loaded_operations[name].task.signedPayloads.push(signed_payload)
    },

    // NOTE Deleting an operation from the current session list
    delete: function (name) {
      delete XMTransactions.data.loaded_operations[name]
      const index = XMTransactions.data.operations_index.indexOf(name)
      XMTransactions.data.operations_index.splice(index, 1)
    },

    clear: function () {
      XMTransactions.data.loaded_operations = {}
      XMTransactions.data.operations_index = []
    },

    // NOTE Changing operation order for an operation from the current session list
    reorder: function (name, index) {
      // FIXME Security: check boundaries to avoid circling
      const operation_current = XMTransactions.data.operations_index.indexOf(name)
      // Deleting and...
      XMTransactions.data.operations_index.splice(operation_current, 1)
      // ...inserting it at the new index
      XMTransactions.data.operations_index.splice(index, 0, name)
    },

    // NOTE Updating an operation from the current session list
    // megabudino was here: I added the conditional parameter; changed operation.task = task to not overwrite
    update: function (name, chain, subchain, is_evm, rpc, task, conditional) {
      const operation = { ...XMTransactions.schemas.base_operation }
      operation.chain = chain
      operation.subchain = subchain
      operation.is_evm = is_evm
      operation.rpc = rpc
      operation.task.type = task.type
      operation.task.params = task.params
      operation.conditional = conditional
      XMTransactions.data.loaded_operations[name] = operation
    },

    // ANCHOR Getters

    // NOTE Getting all the operations from the current session list
    get: function () {
      return XMTransactions.data.loaded_operations
    },

    // NOTE Getting an operation from the current session list by name
    get_by_name: function (name) {
      return XMTransactions.data.loaded_operations[name]
    },

    get_ordered_index: function () {
      return XMTransactions.data.operations_index
    }

  }

}

export default XMTransactions
