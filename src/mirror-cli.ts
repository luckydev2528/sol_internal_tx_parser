/**
 * CLI tool to test the mirror functionality against a real Axiom Trade transaction.
 *
 * This fetches a real transaction from RPC, converts it to outer-only data
 * (no inner instructions), decodes the Axiom swap, and rebuilds a mirrored
 * transaction using a random keypair — demonstrating the full mirror pipeline.
 *
 * Usage:
 *   npx ts-node src/mirror-cli.ts <transaction-signature> [rpc-url]
 *
 * Example:
 *   npx ts-node src/mirror-cli.ts 4TphkyQv7wnYRkiD2WcujxafffAoNuT9HJn83AdGrBrM1TdQ8X2FFZVZ1oEaWV7n97wFnygoqupr48kf2zAjvGtM
 */

import {
  Keypair,
  PublicKey,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { createConnection } from "./utils/connection";
import {
  findAxiomSwapInstruction,
  isAxiomTransaction,
  mirrorAxiomSwap,
} from "./mirror";
import { simulateAndSummarize } from "./simulator/simulator";
import { AXIOM_TRADE_PROGRAM_ID } from "./constants";

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  if (args.length < 1) {
    console.error(
      "Usage: npx ts-node src/mirror-cli.ts <transaction-signature> [rpc-url]"
    );
    process.exit(1);
  }

  const signature = args[0]!;
  const rpcUrl = args[1] || "https://api.mainnet-beta.solana.com";

  console.log(`\n🪞 Mirror CLI — Axiom Trade Swap Mirror Test`);
  console.log(`${"═".repeat(60)}`);
  console.log(`📝 Signature: ${signature}`);
  console.log(`📡 RPC:       ${rpcUrl}`);
  if (!args[1]) {
    console.log(
      `  ⚠️  Using default public RPC — may be rate-limited. Pass your own RPC URL as 2nd arg.`
    );
  }
  console.log();

  const connection = createConnection(rpcUrl);

  // ── Step 1: Fetch the raw transaction ──────────────────────────────────

  console.log("Step 1: Fetching raw transaction...");
  const rawResponse = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  if (!rawResponse) {
    console.error("❌ Transaction not found");
    process.exit(1);
  }

  if (rawResponse.meta?.err) {
    console.warn(
      `⚠️  Transaction failed on-chain: ${JSON.stringify(rawResponse.meta.err)}`
    );
  }

  // Access the VersionedMessage from the response
  const message = rawResponse.transaction.message;
  const staticKeys = message.staticAccountKeys;
  const compiledIxs = message.compiledInstructions;

  console.log(`  ✅ Fetched transaction with ${staticKeys.length} static accounts`);
  console.log(`  📋 ${compiledIxs.length} outer instruction(s)`);

  // ── Step 2: Resolve Address Lookup Tables ──────────────────────────────

  console.log("\nStep 2: Resolving address lookup tables...");
  const addressTableLookups = message.addressTableLookups;

  let resolvedKeys: PublicKey[] = [...staticKeys];

  if (addressTableLookups.length > 0) {
    console.log(
      `  📋 Found ${addressTableLookups.length} ALT(s), resolving...`
    );

    const altAccounts: AddressLookupTableAccount[] = [];
    for (const lookup of addressTableLookups) {
      const result = await connection.getAddressLookupTable(lookup.accountKey);
      if (result.value) {
        altAccounts.push(result.value);
      }
    }

    // Resolve loaded addresses from ALTs (writable first, then readonly)
    const writableKeys: PublicKey[] = [];
    const readonlyKeys: PublicKey[] = [];

    for (let i = 0; i < addressTableLookups.length; i++) {
      const lookup = addressTableLookups[i]!;
      const altAccount = altAccounts[i];
      if (!altAccount) continue;

      for (const idx of lookup.writableIndexes) {
        const addr = altAccount.state.addresses[idx];
        if (addr) writableKeys.push(addr);
      }
      for (const idx of lookup.readonlyIndexes) {
        const addr = altAccount.state.addresses[idx];
        if (addr) readonlyKeys.push(addr);
      }
    }

    resolvedKeys = [...staticKeys, ...writableKeys, ...readonlyKeys];
    console.log(
      `  ✅ Resolved ${resolvedKeys.length} total account keys (${staticKeys.length} static + ${writableKeys.length} writable + ${readonlyKeys.length} readonly from ALT)`
    );
  } else {
    console.log("  ℹ️  No address lookup tables");
  }

  // ── Step 3: Convert to RawOuterTransaction ─────────────────────────────

  console.log("\nStep 3: Converting to outer-only transaction data...");

  // Build the RawOuterTransaction manually from the VersionedMessage
  // (this simulates what a gRPC/LaserStream feed would provide)
  const outerInstructions = compiledIxs.map((cix) => ({
    programIdIndex: cix.programIdIndex,
    accounts: Array.from(cix.accountKeyIndexes),
    data: Buffer.from(cix.data),
  }));

  const rawOuterTx = {
    accountKeys: resolvedKeys,
    instructions: outerInstructions,
    addressTableLookups:
      addressTableLookups.length > 0
        ? addressTableLookups.map((l) => ({
            accountKey: l.accountKey,
            writableIndexes: Array.from(l.writableIndexes),
            readonlyIndexes: Array.from(l.readonlyIndexes),
          }))
        : undefined,
  };

  console.log("  ✅ Built RawOuterTransaction from outer data only");
  console.log(
    `     (NO inner instructions, NO parsed metadata, NO token balances)`
  );

  // ── Step 4: Check if it's an Axiom transaction ─────────────────────────

  console.log("\nStep 4: Detecting Axiom Trade instruction...");
  if (!isAxiomTransaction(rawOuterTx)) {
    console.error("❌ Not an Axiom Trade transaction");
    console.log("   Instruction programs found:");
    for (const ix of rawOuterTx.instructions) {
      if (ix.programIdIndex < resolvedKeys.length) {
        console.log(
          `     - ${resolvedKeys[ix.programIdIndex]!.toBase58()}`
        );
      }
    }
    process.exit(1);
  }
  console.log(
    `  ✅ Axiom Trade program detected (${AXIOM_TRADE_PROGRAM_ID.toBase58()})`
  );

  // ── Step 5: Decode the swap from outer data ────────────────────────────

  console.log("\nStep 5: Decoding swap from outer transaction structure...");
  const decoded = findAxiomSwapInstruction(rawOuterTx);

  if (!decoded) {
    console.error("❌ Could not decode Axiom swap instruction from outer data");
    process.exit(1);
  }

  console.log("\n=== Decoded Swap (outer data only) ===");
  console.log(`  Instruction Type: ${decoded.instructionType}`);
  console.log(`  Direction:        ${decoded.direction.toUpperCase()}`);
  console.log(`  DEX:              ${decoded.dex}`);
  console.log(`  Token Mint:       ${decoded.tokenMint.toBase58()}`);
  console.log(`  Token Program:    ${decoded.tokenProgramType}`);
  console.log(`  Original Signer:  ${decoded.signer.toBase58()}`);
  console.log(`  Amount In:        ${decoded.amountIn}`);
  console.log(`  Min Amount Out:   ${decoded.minAmountOut}`);

  if (decoded.direction === "buy") {
    const solAmount = Number(decoded.amountIn) / 1e9;
    console.log(`  Amount In (SOL):  ${solAmount.toFixed(9)} SOL`);
  }

  console.log(`\n  Pump.fun Account Layout:`);
  const accs = decoded.pumpfunAccounts;
  console.log(`    [0]  Global:            ${accs.global.toBase58()}`);
  console.log(`    [1]  Fee Recipient:     ${accs.feeRecipient.toBase58()}`);
  console.log(`    [2]  Mint:              ${accs.mint.toBase58()}`);
  console.log(`    [3]  Bonding Curve:     ${accs.bondingCurve.toBase58()}`);
  console.log(
    `    [4]  Assoc. BC:         ${accs.associatedBondingCurve.toBase58()}`
  );
  console.log(`    [5]  Assoc. User (ATA): ${accs.associatedUser.toBase58()}`);
  console.log(`    [6]  Signer:            ${accs.signer.toBase58()}`);
  console.log(`    [7]  System Program:    ${accs.systemProgram.toBase58()}`);
  console.log(`    [8]  Token Program:     ${accs.tokenProgram.toBase58()}`);
  console.log(`    [9]  Creator Vault:     ${accs.creatorVault.toBase58()}`);
  console.log(`    [10] Event Authority:   ${accs.eventAuthority.toBase58()}`);
  console.log(`    [11] DEX Program:       ${accs.dexProgram.toBase58()}`);
  if (accs.globalVolumeAccumulator) {
    console.log(
      `    [12] Global Vol. Acc:   ${accs.globalVolumeAccumulator.toBase58()}`
    );
  }
  if (accs.userVolumeAccumulator) {
    console.log(
      `    [13] User Vol. Acc:     ${accs.userVolumeAccumulator.toBase58()}`
    );
  }
  if (accs.feeConfig) {
    console.log(
      `    [14] Fee Config:        ${accs.feeConfig.toBase58()}`
    );
  }
  if (accs.feeProgram) {
    console.log(
      `    [15] Fee Program:       ${accs.feeProgram.toBase58()}`
    );
  }

  // ── Step 6: Mirror the swap ────────────────────────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  console.log("Step 6: Mirroring swap with random keypair...\n");

  const mirrorKeypair = Keypair.generate();
  console.log(
    `  🔑 Mirror Wallet: ${mirrorKeypair.publicKey.toBase58()} (random — for testing only)`
  );

  const fixedBuyAmount = BigInt(100_000_000); // 0.1 SOL for testing
  console.log(
    `  💰 Fixed Buy Amount: ${Number(fixedBuyAmount) / 1e9} SOL (${fixedBuyAmount} lamports)`
  );

  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  const mirrorResult = await mirrorAxiomSwap(
    rawOuterTx,
    mirrorKeypair,
    blockhash,
    {
      fixedBuyAmountLamports: fixedBuyAmount,
      slippageBps: 5000, // 50% for meme coins
      computeUnitLimit: 200_000,
      computeUnitPrice: BigInt(100_000), // 0.0001 SOL priority fee
      createATA: true,
      connection,
    }
  );

  if (!mirrorResult.success) {
    console.error(`  ❌ Mirror failed: ${mirrorResult.error}`);
    process.exit(1);
  }

  console.log(`  ✅ Mirror successful!`);

  const info = mirrorResult.swapInfo!;
  console.log(`\n=== Mirror Result ===`);
  console.log(`  Direction:          ${info.direction.toUpperCase()}`);
  console.log(`  Token Mint:         ${info.tokenMint}`);
  console.log(`  DEX:                ${info.dex}`);
  console.log(`  Token Program:      ${info.tokenProgramType}`);
  console.log(`  Original Amount In: ${info.originalAmountIn}`);
  console.log(`  Original Min Out:   ${info.originalMinAmountOut}`);
  console.log(`  Mirror Amount In:   ${info.mirrorAmountIn}`);
  console.log(`  Mirror Min Out:     ${info.mirrorMinAmountOut}`);
  console.log(
    `  Instructions Built: ${mirrorResult.instructions!.length}`
  );

  // ── Step 7: Compare original vs mirrored ───────────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  console.log("Step 7: Comparing original vs mirrored...\n");

  console.log("  Original Transaction:");
  console.log(`    Signer:    ${decoded.signer.toBase58()}`);
  console.log(`    Amount In: ${decoded.amountIn} lamports`);
  if (decoded.direction === "buy") {
    console.log(
      `               (${(Number(decoded.amountIn) / 1e9).toFixed(9)} SOL)`
    );
  }
  console.log(`    Min Out:   ${decoded.minAmountOut}`);

  console.log("\n  Mirrored Transaction:");
  console.log(`    Signer:    ${mirrorKeypair.publicKey.toBase58()}`);
  console.log(`    Amount In: ${info.mirrorAmountIn} lamports`);
  if (info.direction === "buy") {
    console.log(
      `               (${(Number(info.mirrorAmountIn) / 1e9).toFixed(9)} SOL)`
    );
  }
  console.log(`    Min Out:   ${info.mirrorMinAmountOut}`);

  // Show the remapped accounts in the Axiom swap instruction
  const axiomIx = mirrorResult.instructions!.find(
    (ix) => ix.programId.toBase58() === AXIOM_TRADE_PROGRAM_ID.toBase58()
  );
  if (axiomIx) {
    console.log("\n  Remapped Accounts in Mirror Instruction:");
    console.log(
      `    [5] ATA:    ${axiomIx.keys[5]?.pubkey.toBase58() ?? "N/A"} (remapped)`
    );
    console.log(
      `    [6] Signer: ${axiomIx.keys[6]?.pubkey.toBase58() ?? "N/A"} (remapped)`
    );
    if (axiomIx.keys.length > 13) {
      console.log(
        `    [13] User Vol. Acc: ${axiomIx.keys[13]?.pubkey.toBase58() ?? "N/A"} (remapped)`
      );
    }

    console.log("\n  Unchanged Accounts:");
    console.log(
      `    [0] Global:         ${axiomIx.keys[0]?.pubkey.toBase58() ?? "N/A"}`
    );
    console.log(
      `    [2] Mint:           ${axiomIx.keys[2]?.pubkey.toBase58() ?? "N/A"}`
    );
    console.log(
      `    [3] Bonding Curve:  ${axiomIx.keys[3]?.pubkey.toBase58() ?? "N/A"}`
    );
    console.log(
      `    [9] Creator Vault:  ${axiomIx.keys[9]?.pubkey.toBase58() ?? "N/A"}`
    );
    console.log(
      `    [11] DEX Program:   ${axiomIx.keys[11]?.pubkey.toBase58() ?? "N/A"}`
    );
  }

  // ── Step 8: Simulate the mirrored transaction ──────────────────────────

  console.log(`\n${"─".repeat(60)}`);
  console.log("Step 8: Simulating mirrored transaction...\n");
  console.log(
    "  ⚠️  Note: Simulation will likely fail because the random keypair"
  );
  console.log("     has no SOL balance. This is expected for testing.");
  console.log("     In production, use a funded wallet.\n");

  try {
    const simSummary = await simulateAndSummarize(
      connection,
      mirrorResult.instructions!,
      mirrorKeypair.publicKey
    );
    console.log(simSummary);
  } catch (err: any) {
    console.log(`  Simulation error: ${err.message || err}`);
  }

  console.log(`\n${"═".repeat(60)}`);
  console.log("✅ Mirror CLI test complete!");
  console.log(`${"═".repeat(60)}\n`);
}

main().catch((err) => {
  console.error("❌ Error:", err.message || err);
  process.exit(1);
});
