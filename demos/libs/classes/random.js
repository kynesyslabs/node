// INFO Using random.org we obtain true randomness and the same result everywhere.
var PRNG = require("prng")
var https = require("node:https")
// FIXME We need to bulild a new source of entropy as this would differ from node to node
// Also we don't want to rely on random.org

class TRNG {
	constructor() {
		this.entropy = 0
		this.number = 0
	}
	// INFO Generate a random number.
	new() {
		this.entropy = https.request("https://www.random.org/integers/?num=1&min=-1000000000&max=1000000000&col=1&base=10&format=plain&rnd=new")
		let generator = new PRNG(this.entropy)
		this.number = generator.rand(1, 1000000000)
		return this.number
	}
	newBetween(min, max) {
		this.entropy = https.request("https://www.random.org/integers/?num=1&min=-1000000000&max=1000000000&col=1&base=10&format=plain&rnd=new")
        let generator = new PRNG(this.entropy)
        this.number = generator.rand(min, max)
        return this.number
	}
	currentEntropy() { 
		this.entropy = https.request("https://www.random.org/integers/?num=1&min=-1000000000&max=1000000000&col=1&base=10&format=plain&rnd=new")
		return this.entropy
	}
	// INFO Extract a random element form a list
	randomOf(items) {
		this.entropy = https.request("https://www.random.org/integers/?num=1&min=-1000000000&max=1000000000&col=1&base=10&format=plain&rnd=new")
		let gen = this.new()
		let i
		for (i=0; i<this.gen; i++) {
			let index = i // Copying this so that we can manipulate index without interfering with the for cycle
			if (index > items.length) {
				index = 0
			}
		}
		return items[index]
	}
		

}

module.exports = TRNG
