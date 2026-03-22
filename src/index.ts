import dotenv from "dotenv";
import { PublicKey } from "@solana/web3.js";
import { AxiomTransactionParser } from "./parser";
import { InstructionRebuilder } from "./rebuilder";
import { TransactionSimulator } from "./simulator";
import { SwapDirection } from "./types";

dotenv.config();

// Re-export all public APIs
export { AxiomTransactionParser } from "./parser";
export { InstructionRebuilder } from "./rebuilder";
export { TransactionSimulator } from "./simulator";
export * from "./types";
export * from "./constants";
export * from "./utils";

/**
 * Main entry point - parse a transaction, extract routing, rebuild, and simulate.
 */
async function main(): Promise<void> {
  const rpcEndpoint =
    process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";

  // Reference transaction from the issue
  const txSignature =
    process.argv[2] ||
    "4TphkyQv7wnYRkiD2WcujxafffAoNuT9HJn83AdGrBrM1TdQ8X2FFZVZ1oEaWV7n97wFnygoqupr48kf2zAjvGtM";

  console.log("=== Axiom Trade Transaction Parser ===\n");
  console.log(`RPC: ${rpcEndpoint}`);
  console.log(`TX:  ${txSignature}\n`);

  // Step 1: Parse the transaction
  console.log("--- Step 1: Parsing transaction ---");
  const parser = new AxiomTransactionParser(rpcEndpoint);

  let routingInfo;
  try {
    routingInfo = await parser.parseTransaction(txSignature);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to parse transaction: ${msg}`);
    process.exit(1);
  }

  const { swap } = routingInfo;

  console.log(`\nRouting Info:`);
  console.log(`  Signer:          ${swap.signer}`);
  console.log(`  Router Program:  ${swap.routerProgram}`);
  console.log(`  Platform:        ${swap.platform}`);
  console.log(
    `  Direction:       ${swap.direction === SwapDirection.SOL_TO_TOKEN ? "SOL → Token" : "Token → SOL"}`
  );
  console.log(`  Token Mint:      ${swap.tokenMint}`);
  console.log(`  SOL Amount:      ${swap.solAmount} SOL`);
  console.log(`  Token Amount:    ${swap.tokenAmount}`);
  console.log(`  Token Decimals:  ${swap.tokenDecimals}`);
  console.log(`  Token Program:   ${swap.tokenProgramType}`);

  if (routingInfo.pumpFunAccounts) {
    const accs = routingInfo.pumpFunAccounts;
    console.log(`\nPump.fun Account Mapping:`);
    console.log(`  Global:                  ${accs.global.toBase58()}`);
    console.log(`  Fee Recipient:           ${accs.feeRecipient.toBase58()}`);
    console.log(`  Mint:                    ${accs.mint.toBase58()}`);
    console.log(`  Bonding Curve:           ${accs.bondingCurve.toBase58()}`);
    console.log(
      `  Assoc. Bonding Curve:    ${accs.associatedBondingCurve.toBase58()}`
    );
    console.log(`  Assoc. User (ATA):       ${accs.associatedUser.toBase58()}`);
    console.log(`  User:                    ${accs.user.toBase58()}`);
    console.log(`  System Program:          ${accs.systemProgram.toBase58()}`);
    console.log(`  Token Program:           ${accs.tokenProgram.toBase58()}`);
    console.log(`  Creator Vault:           ${accs.creatorVault.toBase58()}`);
  }

  if (routingInfo.tradeEvent) {
    const event = routingInfo.tradeEvent;
    console.log(`\nPump.fun TradeEvent:`);
    console.log(`  Mint:                    ${event.mint.toBase58()}`);
    console.log(`  SOL Amount:              ${Number(event.solAmount) / 1e9} SOL`);
    console.log(`  Token Amount:            ${Number(event.tokenAmount) / 1e6}`);
    console.log(`  Is Buy:                  ${event.isBuy}`);
    console.log(`  User:                    ${event.user.toBase58()}`);
    console.log(
      `  Virtual SOL Reserves:    ${Number(event.virtualSolReserves) / 1e9} SOL`
    );
    console.log(
      `  Virtual Token Reserves:  ${Number(event.virtualTokenReserves) / 1e6}`
    );
  }

  // Step 2: Rebuild the instruction
  console.log("\n--- Step 2: Rebuilding instruction ---");
  const rebuilder = new InstructionRebuilder(rpcEndpoint);

  let rebuilt;
  try {
    rebuilt = await rebuilder.rebuildPumpFunBuy(
      routingInfo,
      new PublicKey(swap.signer),
      swap.solAmount,
      1000 // 10% slippage
    );

    console.log(`  Program ID:  ${rebuilt.programId}`);
    console.log(`  Data:        ${rebuilt.data.substring(0, 40)}...`);
    console.log(`  Accounts:    ${rebuilt.accounts.length}`);
    rebuilt.accounts.forEach((a, i) => {
      console.log(
        `    [${i}] ${a.pubkey} (signer: ${a.isSigner}, writable: ${a.isWritable})`
      );
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to rebuild instruction: ${msg}`);
    console.log("(This may be expected if the RPC endpoint is not accessible)");
    return;
  }

  // Step 3: Simulate
  console.log("\n--- Step 3: Simulating transaction ---");
  const simulator = new TransactionSimulator(rpcEndpoint);

  try {
    const simResult = await simulator.simulate(rebuilt.serializedTransaction);

    console.log(`  Success:         ${simResult.success}`);
    console.log(`  Units Consumed:  ${simResult.unitsConsumed}`);
    if (simResult.error) {
      console.log(`  Error:           ${simResult.error}`);
    }
    console.log(`  Logs:`);
    simResult.logs.forEach((log) => console.log(`    ${log}`));
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Failed to simulate: ${msg}`);
    console.log("(This may be expected if the RPC endpoint is not accessible)");
  }
}

// Only run main if this is the entry point
if (require.main === module) {
  main().catch(console.error);
}
