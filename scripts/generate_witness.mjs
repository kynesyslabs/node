import { readFileSync, writeFileSync } from 'fs';
import { resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function generateWitness() {
    // Dynamic import of witness calculator (CommonJS module)
    const wasmPath = resolve(__dirname, '../src/features/zk/circuits/identity_with_merkle_js/identity_with_merkle.wasm');
    const inputPath = process.argv[2] || 'test_input.json';
    const outputPath = process.argv[3] || 'test_witness.wtns';

    // Load input
    const input = JSON.parse(readFileSync(inputPath, 'utf-8'));

    // Load WASM
    const wasmBuffer = readFileSync(wasmPath);

    // Import witness calculator
    const witnessCalculatorPath = resolve(__dirname, '../src/features/zk/circuits/identity_with_merkle_js/witness_calculator.js');
    const { default: WitnessCalculator } = await import(witnessCalculatorPath);

    // Calculate witness
    const wc = await WitnessCalculator(wasmBuffer);
    const witnessBuffer = await wc.calculateWTNSBin(input, 0);

    // Write witness file
    writeFileSync(outputPath, witnessBuffer);

    console.log(`✅ Witness written to ${outputPath}`);
}

generateWitness().catch(err => {
    console.error('❌ Error generating witness:', err);
    process.exit(1);
});
