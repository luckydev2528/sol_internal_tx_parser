/**
 * CLI tool to parse an Axiom Trade transaction.
 *
 * Usage:
 *   npx ts-node src/cli.ts <transaction-signature> [rpc-url]
 *
 * Example:
 *   npx ts-node src/cli.ts 4TphkyQv7wnYRkiD2WcujxafffAoNuT9HJn83AdGrBrM1TdQ8X2FFZVZ1oEaWV7n97wFnygoqupr48kf2zAjvGtM
 */

import { createConnection } from "./utils/connection";
import { parseAxiomTransaction } from "./parser/axiomParser";
import { parseAxiomFromParsedTransaction } from "./parser/axiomParser";
import { analyzeRoutingLayout, describeRoutingLayout } from "./parser/routingLayout";
import { buildSwapInstructions } from "./builder/instructionBuilder";
import { simulateAndSummarize } from "./simulator/simulator";
import { SwapDirection, TokenProgramType } from "./types";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error(
      "Usage: npx ts-node src/cli.ts <transaction-signature> [rpc-url]"
    );
    process.exit(1);
  }

  const signature = args[0]!;
  const rpcUrl = args[1] || "https://api.mainnet-beta.solana.com";

  console.log(`\n🔍 Parsing Axiom Trade transaction: ${signature}`);
  console.log(`📡 RPC: ${rpcUrl}\n`);

  const connection = createConnection(rpcUrl);

  // Step 1: Parse the transaction
  console.log("Step 1: Fetching and parsing transaction...");
  const result = await parseAxiomTransaction(connection, signature);

  console.log("\n=== Parsed Swap Result ===");
  console.log(`  Signer:           ${result.signer}`);
  console.log(`  Instruction Type: ${result.instructionType}`);
  console.log(`  Direction:        ${result.direction}`);
  console.log(`  DEX:              ${result.dex}`);
  console.log(`  Token Mint:       ${result.tokenMint}`);
  console.log(`  Token Program:    ${result.tokenProgramType}`);
  console.log(
    `  SOL Amount:       ${Math.abs(result.solAmount).toFixed(9)} SOL`
  );
  console.log(
    `  Token Amount:     ${Math.abs(result.tokenAmount).toFixed(6)} tokens`
  );

  // Step 2: Get the full parsed instruction for routing analysis
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  if (tx) {
    const parsedIx = parseAxiomFromParsedTransaction(tx);
    const routing = analyzeRoutingLayout(
      parsedIx.dex,
      parsedIx.direction,
      parsedIx.accounts
    );

    console.log("\n=== Routing Layout ===");
    console.log(describeRoutingLayout(routing));

    // Step 3: Rebuild the instruction
    console.log("\n\nStep 3: Rebuilding swap instruction...");
    const rebuildResult = await buildSwapInstructions(connection, {
      signer: parsedIx.accounts.signer,
      mint: parsedIx.mint,
      amountIn: parsedIx.amountIn,
      minAmountOut: parsedIx.minAmountOut,
      direction: parsedIx.direction,
      tokenProgramType:
        routing.tokenProgramType === TokenProgramType.TOKEN_2022
          ? TokenProgramType.TOKEN_2022
          : TokenProgramType.TOKEN,
    });

    console.log(
      `  Built ${rebuildResult.instructions.length} instructions`
    );
    console.log(
      `  Compute Units: ${rebuildResult.computeUnits}`
    );

    // Step 4: Simulate the rebuilt transaction
    console.log("\nStep 4: Simulating rebuilt transaction...");
    const simSummary = await simulateAndSummarize(
      connection,
      rebuildResult.instructions,
      parsedIx.accounts.signer
    );
    console.log(simSummary);
  }

  console.log("\n✅ Done!");
}

main().catch((err) => {
  console.error("❌ Error:", err.message || err);
  process.exit(1);
});
