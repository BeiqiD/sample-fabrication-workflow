import { verifyNodeDistribution } from "./lib/node-distribution-v28-manifest.mjs";

const args = process.argv.slice(2);
if (args.length < 1 || args.length > 2 || args[1] !== undefined && args[1] !== "--runtime") {
  process.stderr.write("Usage: verify-node-distribution.mjs DIRECTORY [--runtime]\n");
  process.exitCode = 2;
} else {
  try {
    const receipt = await verifyNodeDistribution(args[0], { enforceRuntimeVersion: args[1] === "--runtime" });
    process.stdout.write(`${JSON.stringify(receipt)}\n`);
  } catch {
    // Paths, malformed source, key material and account configuration are not diagnostics.
    process.stderr.write("Node distribution integrity check failed\n");
    process.exitCode = 1;
  }
}
