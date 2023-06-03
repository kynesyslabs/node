// INFO This is a socket based organized and handy way to communicate between modules
// * Simplified schema of the below example
// main.js <--- module_a.js
// main.js <--- module_b.js
// in main.js we have variable x = 1
// by using imc.broadcast("x", 1) we can send the variable to all the modules
// we can do the same to change it later: imc.broadcast("x", 2)
// * For every module that will share informations with us, it needs to import air.js
// * and initialize it with a name, then export the imc interface
// ** In module.js
// var air = require("./air.js")
// var imc = new air()
// imc.initialize("module_name")
// * Now in main.js (or any controller script anyway) we can import the module and register it
// ** In main.js
// const module = require("./module.js")
// imc.registered_modules.push({ name: "module_name", registered: true, socket: module.imc })
// * Now we can set variables valid for all the modules we registered
// ** In main.js
// imc.states["variable"] = "value" // Registering locally
// imc.broadcast("variable", "value") // Broadcasting to all the modules
// * After this point, the module can access the variable with imc.states["variable"]
// ** In module.js
// module.writeFile(imc.states["variable"])

// air.js
var util = require("util")
var EventEmitter = require("events").EventEmitter

// INFO Registering as an emitter
// This code is used to start an emitter.
class air {
	constructor() {
		this.registered_modules = [] // { name: module_name, registered: true/false, socket: socket}
		this.states = {}
	}
	start(name) {
		this.emit("start", name)
	}

	// ANCHOR Emitter section
	// Method to send data to other modules
	send(variable, data, module) {
		let packet = {
			sender: this,
			data: {},
		}
		packet.data[variable] = data
		module.emit(packet)
		// Broadcast to the registered modules
		this.registered_modules.forEach((module) => {
			module.socket.emit(packet)
		})
	}
	// Method to broadcast data to all the modules we know overriding the registration flag
	broadcast(variable, data) {
		let packet = [variable, data]
		this.registered_modules.forEach((module) => {
			console.log("[AIR IMC] Broadcasting to " + module.name)
			module.socket.emit("broadcast", packet)
		})
	}

	// ANCHOR Receiver section
	initialize(fancy_name) {
		// listen for events
		this.on("start", (name) => {
			console.log("[AIR IMC][" + name + "] Emitter started: " + name)
		})
		this.on("register", (module) => {
			this.registered_modules.push(module)
		})
		this.on("unregister", (module) => {
			this.registered_modules.splice(this.registered_modules.indexOf(module), 1)
		})
		// Receiving states
		this.on("send", (packet) => {
			let variable = Object.keys(packet.data)[0]
			this.states[variable] = packet.data[variable]
		})
		// Receiving broadcasts (same as states)
		this.on("broadcast", (packet) => {
			let variable = packet[0]
			let value = packet[1]
			this.states[variable] = value
			console.log(
				"[AIR IMC][" +
					fancy_name +
					"] Broadcast received: " +
					variable +
					" = " +
					value
			)
		})
		//Starting the object
		this.start(fancy_name)
	}
}

util.inherits(air, EventEmitter)

module.exports = air
