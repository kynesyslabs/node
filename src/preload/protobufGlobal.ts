// tronweb's generated protobuf modules extend a global `proto` that only one
// of them creates, and Bun does not always evaluate CommonJS modules imported
// from ESM in import order, so a start-up could die on "proto is not defined".
// Creating the namespace before the module graph loads removes the ordering.
const g = globalThis as { proto?: object }
g.proto ??= {}
