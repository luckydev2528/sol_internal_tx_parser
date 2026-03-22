/**
 * Offline unit tests for the Axiom Trade transaction parser.
 *
 * These tests validate the core parsing, PDA derivation, routing layout
 * analysis, and instruction building logic without requiring network access.
 */

import { PublicKey } from "@solana/web3.js";
import {
  AXIOM_TRADE_PROGRAM_ID,
  PUMPFUN_PROGRAM_ID,
  PUMPFUN_FEE_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  AXIOM_DISCRIMINATORS,
  PUMPFUN_DISCRIMINATORS,
  PUMPFUN_FEE_RECIPIENT,
  NATIVE_MINT,
} from "../constants";
import {
  decodeAxiomDiscriminator,
  decodePumpfunDiscriminator,
  decodeSwapArgs,
  encodeSwapData,
  readU64LE,
  writeU64LE,
} from "../utils/decoder";
import {
  derivePumpfunGlobal,
  derivePumpfunBondingCurve,
  derivePumpfunAssociatedBondingCurve,
  derivePumpfunEventAuthority,
  derivePumpfunCreatorVault,
  derivePumpfunGlobalVolumeAccumulator,
  derivePumpfunUserVolumeAccumulator,
  derivePumpfunFeeConfig,
  deriveATA,
} from "../utils/pda";
import { analyzeRoutingLayout, describeRoutingLayout } from "../parser/routingLayout";
import {
  AxiomInstructionType,
  DexType,
  PoolOrientation,
  SwapDirection,
  TokenProgramType,
} from "../types";

// ─── Test Utilities ────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(`  ❌ FAIL: ${message}`);
  }
}

function assertEqual(actual: unknown, expected: unknown, message: string): void {
  if (actual === expected) {
    passed++;
    console.log(`  ✅ ${message}`);
  } else {
    failed++;
    console.error(
      `  ❌ FAIL: ${message}\n     Expected: ${String(expected)}\n     Actual:   ${String(actual)}`
    );
  }
}

function section(name: string): void {
  console.log(`\n📋 ${name}`);
}

// ─── Tests ─────────────────────────────────────────────────────────────────

function testConstants(): void {
  section("Constants");

  assertEqual(
    AXIOM_TRADE_PROGRAM_ID.toBase58(),
    "FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9",
    "Axiom Trade program ID correct"
  );

  assertEqual(
    PUMPFUN_PROGRAM_ID.toBase58(),
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "Pump.fun program ID correct"
  );

  assertEqual(
    PUMPFUN_FEE_PROGRAM_ID.toBase58(),
    "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ",
    "Pump.fun fee program ID correct"
  );

  assertEqual(
    TOKEN_PROGRAM_ID.toBase58(),
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "Token program ID correct"
  );

  assertEqual(
    TOKEN_2022_PROGRAM_ID.toBase58(),
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
    "Token-2022 program ID correct"
  );
}

function testDiscriminators(): void {
  section("Discriminators");

  // Test Axiom discriminator decoding
  const buyExactInData = Buffer.alloc(24);
  AXIOM_DISCRIMINATORS.buy_exact_in.copy(buyExactInData, 0);
  assertEqual(
    decodeAxiomDiscriminator(buyExactInData),
    AxiomInstructionType.BUY_EXACT_IN,
    "Decode buy_exact_in discriminator"
  );

  const sellExactInData = Buffer.alloc(24);
  AXIOM_DISCRIMINATORS.sell_exact_in.copy(sellExactInData, 0);
  assertEqual(
    decodeAxiomDiscriminator(sellExactInData),
    AxiomInstructionType.SELL_EXACT_IN,
    "Decode sell_exact_in discriminator"
  );

  const sellData = Buffer.alloc(24);
  AXIOM_DISCRIMINATORS.sell.copy(sellData, 0);
  assertEqual(
    decodeAxiomDiscriminator(sellData),
    AxiomInstructionType.SELL,
    "Decode sell discriminator"
  );

  const buyData = Buffer.alloc(24);
  AXIOM_DISCRIMINATORS.buy.copy(buyData, 0);
  assertEqual(
    decodeAxiomDiscriminator(buyData),
    AxiomInstructionType.BUY,
    "Decode buy discriminator"
  );

  const buyMaxOutData = Buffer.alloc(24);
  AXIOM_DISCRIMINATORS.buy_max_out.copy(buyMaxOutData, 0);
  assertEqual(
    decodeAxiomDiscriminator(buyMaxOutData),
    AxiomInstructionType.BUY_MAX_OUT,
    "Decode buy_max_out discriminator"
  );

  // Test unknown discriminator
  const unknownData = Buffer.alloc(24);
  assertEqual(
    decodeAxiomDiscriminator(unknownData),
    AxiomInstructionType.UNKNOWN,
    "Unknown discriminator returns UNKNOWN"
  );

  // Short data
  const shortData = Buffer.alloc(4);
  assertEqual(
    decodeAxiomDiscriminator(shortData),
    AxiomInstructionType.UNKNOWN,
    "Short data returns UNKNOWN"
  );

  // Pump.fun discriminators
  const pumpBuyData = Buffer.alloc(8);
  PUMPFUN_DISCRIMINATORS.buy.copy(pumpBuyData, 0);
  assertEqual(
    decodePumpfunDiscriminator(pumpBuyData),
    "buy",
    "Decode pump.fun buy discriminator"
  );

  const pumpSellData = Buffer.alloc(8);
  PUMPFUN_DISCRIMINATORS.sell.copy(pumpSellData, 0);
  assertEqual(
    decodePumpfunDiscriminator(pumpSellData),
    "sell",
    "Decode pump.fun sell discriminator"
  );

  // Verify the buy_exact_in hex discriminator matches Anchor convention
  const crypto = require("crypto");
  const expectedDisc = crypto
    .createHash("sha256")
    .update("global:buy_exact_in")
    .digest()
    .subarray(0, 8);
  assert(
    AXIOM_DISCRIMINATORS.buy_exact_in.equals(expectedDisc),
    "buy_exact_in discriminator matches SHA256('global:buy_exact_in')[:8]"
  );
}

function testSwapArgEncoding(): void {
  section("Swap Argument Encoding/Decoding");

  // Test encoding and decoding round-trip
  const amountIn = BigInt("2961200000"); // 2.9612 SOL in lamports
  const minAmountOut = BigInt("25342622492742"); // token amount

  const encoded = encodeSwapData(
    AXIOM_DISCRIMINATORS.buy_exact_in,
    amountIn,
    minAmountOut
  );

  assertEqual(encoded.length, 24, "Encoded data is 24 bytes");

  // Verify discriminator
  assert(
    encoded.subarray(0, 8).equals(AXIOM_DISCRIMINATORS.buy_exact_in),
    "Encoded discriminator correct"
  );

  // Decode and verify
  const decoded = decodeSwapArgs(encoded);
  assertEqual(decoded.amountIn, amountIn, "Decoded amountIn matches");
  assertEqual(
    decoded.minAmountOut,
    minAmountOut,
    "Decoded minAmountOut matches"
  );

  // Test u64 round-trip
  const value = BigInt("18446744073709551615"); // u64 max
  const buf = writeU64LE(value);
  const readBack = readU64LE(buf, 0);
  assertEqual(readBack, value, "u64 max round-trip");

  // Test zero
  const zero = BigInt(0);
  const zeroBuf = writeU64LE(zero);
  const readZero = readU64LE(zeroBuf, 0);
  assertEqual(readZero, zero, "u64 zero round-trip");
}

function testPDADerivation(): void {
  section("PDA Derivation");

  // Test that PDAs can be derived without errors
  const global = derivePumpfunGlobal();
  assert(global instanceof PublicKey, "Global PDA derived successfully");

  // Use a sample mint for testing
  const sampleMint = new PublicKey(
    "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"
  );

  const bondingCurve = derivePumpfunBondingCurve(sampleMint);
  assert(
    bondingCurve instanceof PublicKey,
    "Bonding curve PDA derived successfully"
  );

  const associatedBC = derivePumpfunAssociatedBondingCurve(
    bondingCurve,
    sampleMint
  );
  assert(
    associatedBC instanceof PublicKey,
    "Associated bonding curve PDA derived successfully"
  );

  const eventAuth = derivePumpfunEventAuthority();
  assert(
    eventAuth instanceof PublicKey,
    "Event authority PDA derived successfully"
  );

  const sampleCreator = new PublicKey(
    "H4K5LjkjXVRBsQXJig3xq9L6co6SfoqRiqnih5iohX9A"
  );
  const creatorVault = derivePumpfunCreatorVault(sampleCreator);
  assert(
    creatorVault instanceof PublicKey,
    "Creator vault PDA derived successfully"
  );

  const globalVolAcc = derivePumpfunGlobalVolumeAccumulator();
  assert(
    globalVolAcc instanceof PublicKey,
    "Global volume accumulator PDA derived successfully"
  );

  const userVolAcc = derivePumpfunUserVolumeAccumulator(sampleCreator);
  assert(
    userVolAcc instanceof PublicKey,
    "User volume accumulator PDA derived successfully"
  );

  const feeConfig = derivePumpfunFeeConfig();
  assert(
    feeConfig instanceof PublicKey,
    "Fee config PDA derived successfully"
  );

  // Test ATA derivation
  const owner = new PublicKey(
    "H4K5LjkjXVRBsQXJig3xq9L6co6SfoqRiqnih5iohX9A"
  );
  const ata = deriveATA(owner, sampleMint);
  assert(ata instanceof PublicKey, "ATA derived successfully");

  // ATA with Token-2022
  const ata2022 = deriveATA(owner, sampleMint, TOKEN_2022_PROGRAM_ID);
  assert(ata2022 instanceof PublicKey, "ATA with Token-2022 derived successfully");

  // ATA for different token programs should differ
  assert(
    !ata.equals(ata2022),
    "ATA differs between Token and Token-2022 programs"
  );
}

function testRoutingLayout(): void {
  section("Routing Layout Analysis");

  const sampleAccounts = {
    signer: new PublicKey("H4K5LjkjXVRBsQXJig3xq9L6co6SfoqRiqnih5iohX9A"),
    mint: new PublicKey("7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"),
    bondingCurve: derivePumpfunBondingCurve(
      new PublicKey("7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr")
    ),
    associatedBondingCurve: PublicKey.default,
    associatedUser: PublicKey.default,
    global: derivePumpfunGlobal(),
    feeRecipient: PUMPFUN_FEE_RECIPIENT,
    eventAuthority: derivePumpfunEventAuthority(),
    creatorVault: PublicKey.default,
    systemProgram: SYSTEM_PROGRAM_ID,
    tokenProgram: TOKEN_PROGRAM_ID,
    dexProgram: PUMPFUN_PROGRAM_ID,
  };

  // Test SOL_TO_TOKEN routing
  const buyLayout = analyzeRoutingLayout(
    DexType.PUMPFUN,
    SwapDirection.SOL_TO_TOKEN,
    sampleAccounts
  );

  assertEqual(buyLayout.dex, DexType.PUMPFUN, "Buy routing: DEX is PUMPFUN");
  assertEqual(
    buyLayout.direction,
    SwapDirection.SOL_TO_TOKEN,
    "Buy routing: direction is SOL_TO_TOKEN"
  );
  assertEqual(
    buyLayout.tokenProgramType,
    TokenProgramType.TOKEN,
    "Buy routing: token program is TOKEN"
  );
  assertEqual(
    buyLayout.poolOrientation,
    PoolOrientation.SOL_QUOTE,
    "Buy routing: pool orientation is SOL_QUOTE"
  );

  // Test TOKEN_TO_SOL routing
  const sellLayout = analyzeRoutingLayout(
    DexType.PUMPFUN,
    SwapDirection.TOKEN_TO_SOL,
    sampleAccounts
  );

  assertEqual(sellLayout.dex, DexType.PUMPFUN, "Sell routing: DEX is PUMPFUN");
  assertEqual(
    sellLayout.direction,
    SwapDirection.TOKEN_TO_SOL,
    "Sell routing: direction is TOKEN_TO_SOL"
  );

  // Test Token-2022 routing
  const accounts2022 = {
    ...sampleAccounts,
    tokenProgram: TOKEN_2022_PROGRAM_ID,
  };
  const layout2022 = analyzeRoutingLayout(
    DexType.PUMPFUN,
    SwapDirection.SOL_TO_TOKEN,
    accounts2022
  );
  assertEqual(
    layout2022.tokenProgramType,
    TokenProgramType.TOKEN_2022,
    "Token-2022 routing: token program type is TOKEN_2022"
  );

  // Test describe routing layout doesn't throw
  const description = describeRoutingLayout(buyLayout);
  assert(description.includes("PUMPFUN"), "Description includes DEX name");
  assert(
    description.includes("SOL_TO_TOKEN"),
    "Description includes direction"
  );
  assert(
    description.includes(sampleAccounts.mint.toBase58()),
    "Description includes mint"
  );
}

function testInstructionBuilder(): void {
  section("Instruction Builder");

  // Import inline since it depends on PDA derivation
  const { buildSwapInstructions } = require("../builder/instructionBuilder");
  const { Connection } = require("@solana/web3.js");

  // We can test the instruction structure without actual RPC
  const signer = new PublicKey(
    "H4K5LjkjXVRBsQXJig3xq9L6co6SfoqRiqnih5iohX9A"
  );
  const mint = new PublicKey(
    "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"
  );

  // We can't call buildSwapInstructions without a connection for
  // full flow, but we can test the PDA-based instruction building
  // by verifying individual components

  // Verify the accounts would be correctly ordered
  const bondingCurve = derivePumpfunBondingCurve(mint);
  const assocBC = derivePumpfunAssociatedBondingCurve(
    bondingCurve,
    mint,
    TOKEN_PROGRAM_ID
  );
  const userATA = deriveATA(signer, mint, TOKEN_PROGRAM_ID);

  assert(
    bondingCurve instanceof PublicKey,
    "Builder: bonding curve derived for mint"
  );
  assert(
    assocBC instanceof PublicKey,
    "Builder: associated bonding curve derived"
  );
  assert(userATA instanceof PublicKey, "Builder: user ATA derived for mint");

  // Test WSOL helpers
  const { createWrapSolInstructions, createUnwrapSolInstruction } = require("../builder/instructionBuilder");

  const wrapIxs = createWrapSolInstructions(signer, BigInt(1_000_000_000));
  assertEqual(wrapIxs.length, 3, "WSOL wrap creates 3 instructions");
  assert(
    wrapIxs[0].keys.length > 0,
    "WSOL wrap: create ATA instruction has accounts"
  );
  assert(
    wrapIxs[1].keys.length > 0,
    "WSOL wrap: transfer SOL instruction has accounts"
  );
  assert(
    wrapIxs[2].keys.length > 0,
    "WSOL wrap: sync native instruction has accounts"
  );

  const unwrapIx = createUnwrapSolInstruction(signer);
  assertEqual(
    unwrapIx.programId.toBase58(),
    TOKEN_PROGRAM_ID.toBase58(),
    "WSOL unwrap: uses Token program"
  );
  assertEqual(
    unwrapIx.keys.length,
    3,
    "WSOL unwrap: has 3 accounts"
  );
}

function testEdgeCases(): void {
  section("Edge Cases");

  // Test decode with exact minimum data
  const minData = Buffer.alloc(24);
  AXIOM_DISCRIMINATORS.buy_exact_in.copy(minData, 0);
  const result = decodeSwapArgs(minData);
  assertEqual(result.amountIn, BigInt(0), "Min data: amountIn is 0");
  assertEqual(result.minAmountOut, BigInt(0), "Min data: minAmountOut is 0");

  // Test decode with data too short
  let thrown = false;
  try {
    decodeSwapArgs(Buffer.alloc(16));
  } catch {
    thrown = true;
  }
  assert(thrown, "Short data throws error for decodeSwapArgs");

  // Test that discriminators are unique
  const discValues = Object.values(AXIOM_DISCRIMINATORS);
  const discHexSet = new Set(discValues.map((d) => d.toString("hex")));
  assertEqual(
    discHexSet.size,
    discValues.length,
    "All Axiom discriminators are unique"
  );

  // Test that Pump.fun buy/sell discriminators match Axiom buy/sell
  assert(
    PUMPFUN_DISCRIMINATORS.buy.equals(AXIOM_DISCRIMINATORS.buy),
    "Pump.fun buy discriminator matches Axiom buy (same Anchor name)"
  );
  assert(
    PUMPFUN_DISCRIMINATORS.sell.equals(AXIOM_DISCRIMINATORS.sell),
    "Pump.fun sell discriminator matches Axiom sell (same Anchor name)"
  );
}

// ─── Run All Tests ─────────────────────────────────────────────────────────

console.log("🧪 Running Axiom Trade Parser Tests\n");

testConstants();
testDiscriminators();
testSwapArgEncoding();
testPDADerivation();
testRoutingLayout();
testInstructionBuilder();
testEdgeCases();

console.log(`\n${"═".repeat(50)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
console.log(`${"═".repeat(50)}`);

if (failed > 0) {
  process.exit(1);
}
