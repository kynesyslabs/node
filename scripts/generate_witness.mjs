import { readFileSync, writeFileSync } from 'fs';
import { resolve, isAbsolute, normalize } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function generateWitness() {
    // REVIEW: Path traversal vulnerability fix - validate CLI arguments
    const rawInputPath = process.argv[2] || 'test_input.json';
    const rawOutputPath = process.argv[3] || 'test_witness.wtns';

    // REVIEW: Prevent path traversal attacks - check ".." as path segment, not substring
    // This allows filenames like "file..json" while rejecting actual path traversal
    const normalizedInput = normalize(rawInputPath);
    if (isAbsolute(rawInputPath) || normalizedInput.startsWith('..')) {
        throw new Error('Input path must be relative and cannot contain ".."');
    }

    const normalizedOutput = normalize(rawOutputPath);
    if (isAbsolute(rawOutputPath) || normalizedOutput.startsWith('..')) {
        throw new Error('Output path must be relative and cannot contain ".."');
    }

    // Validate file extensions
    if (!rawInputPath.endsWith('.json')) {
        throw new Error('Input must be a .json file');
    }
    if (!rawOutputPath.endsWith('.wtns')) {
        throw new Error('Output must be a .wtns file');
    }

    // Safely resolve paths relative to current working directory
    const inputPath = resolve(process.cwd(), normalize(rawInputPath));
    const outputPath = resolve(process.cwd(), normalize(rawOutputPath));

    // Dynamic import of witness calculator (CommonJS module)
    const wasmPath = resolve(__dirname, '../src/features/zk/circuits/identity_with_merkle_js/identity_with_merkle.wasm');

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
