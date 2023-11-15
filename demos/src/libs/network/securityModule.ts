// TODO Implement this

export interface ISecurityReport {
	state: boolean,
	code: string,
	message: string,
}

interface SIResponseRegistry {
	prune_interval: number,
}

interface SIComlink {
	rate_limit_size: number, // How many comlinks can be sent in an interval? // TODO Make it configurable
	rate_limit_time: number, // How many milliseconds is an interval? // TODO Make it configurable
	rate_limit_bin: number, // The amount of comlinks sent in the last interval // TODO Make it configurable
	rate_limit_timestamp: number, // The timestamp of the last interval
	checkRateLimits: Function,
}

interface SICommunications {
	response_registry: SIResponseRegistry,
	comlink: SIComlink,	
}

export let modules = {

	// SECTION Modules
	// TODO Make some properties configurable
	communications: {
			response_registry: { 
				prune_interval: 5000, // Milliseconds between responseRegistry pruning operations // Make it configurable
			},
			comlink: {
				rate_limit_size: 5, // How many comlinks can be sent in an interval? // TODO Make it configurable
				rate_limit_time: 1000, // How many milliseconds is an interval? // TODO Make it configurable
				rate_limit_bin: 0, // The amount of comlinks sent in the last interval // TODO Make it configurable
				rate_limit_timestamp: 0, // The timestamp of the last interval
				checkRateLimits: checkRateLimits,
			},
		},
}

// SECTION Internal methods
async function checkRateLimits (reported_timestamp: number): Promise<ISecurityReport> {
	let report: ISecurityReport = {
		code: "0",
		message: "undefined",
		state: undefined,
	}
	// Checking if timestamp changed enough and resetting stuff if needed before starting
	let delta = reported_timestamp - modules.communications.comlink.rate_limit_timestamp
	if (delta >= modules.communications.comlink.rate_limit_time) {
		modules.communications.comlink.rate_limit_bin = 0
		modules.communications.comlink.rate_limit_timestamp = reported_timestamp
	}
	// Snapshotting the actual state
	let rate_limit_size = modules.communications.comlink.rate_limit_size
	let rate_limit_time = modules.communications.comlink.rate_limit_time
	let rate_limit_bin = modules.communications.comlink.rate_limit_bin
	let rate_limit_timestamp = modules.communications.comlink.rate_limit_timestamp
	// Checking how many comlinks are currently in the bin compared to our limit
	if ( rate_limit_size > 0 && (rate_limit_bin > rate_limit_size)) {
		report.code = "429"
		report.message = "rate limit exceeded (" + rate_limit_size.toString() + "). Please wait " + (rate_limit_time.toString()) + " seconds"
		report.state = false
	} else {
		rate_limit_bin += 1
		report.code = "200"
		report.message = "ok"
		report.state = true
	}
	return report
}

// Exporting
