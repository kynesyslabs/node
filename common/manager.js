// INFO This script is used to manage EVM and DEMOS instances (for example: adding validators in EVM, etc)
const fs = require('fs');
const { spawn } = require('child_process');
var term = require('terminal-kit').terminal;
// Loading configuration
const config = JSON.parse(fs.readFileSync('./config.json', 'utf8'));

// Shared variables
var evm_instance;
var demos_instance;

// NOTE Run and manages EVM instance
async function run_evm_instance() {
	evm_instance = spawn("sh", ["run.sh"], {cwd: config.evm_path});
	evm_instance.stdout.on('data', (data) => {
        term.bgGreen.red("[EVM LAYER]> " + data.toString());
    });
	evm_instance.stderr.on('data', (data) => {
        term.bgRed.red.bold("[EVM LAYER]> " + data.toString());
    });
}

// NOTE Run and manages DEMOS instance
async function run_demos_instance() {
	demos_instance = spawn("node", ["main.js"], {cwd: config.demos_path});
	demos_instance.stdout.on('data', (data) => {
        term.bgBlue.yellow("[DEMOS LAYER]> " + data.toString());
    });
	demos_instance.stderr.on('data', (data) => {
        term.bgBlue.yellow.bold("[DEMOS LAYER]> " + data.toString());
    });
}

// ANCHOR Entry point
(async () => {
	// Checking sanity of configuration
	if (!config.evm_path || !fs.existsSync(config.evm_path)) {
		term.red('EVM path is not defined or does not exist\n');
        process.exit(-1);
	}
	if (!config.demos_path ||!fs.existsSync(config.demos_path)) {
        term.red('Demo path is not defined or does not exist\n');
        process.exit(-1);
    }
	// Proceeding
	term.bgWhite.green('Configuration loaded');
	await run_evm_instance();
	await run_demos_instance();
})();