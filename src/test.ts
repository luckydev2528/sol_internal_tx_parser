import { PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import {
  AXIOM_PROGRAM_ID,
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_BUY_DISCRIMINATOR,
  PUMP_FUN_SELL_DISCRIMINATOR,
  PUMP_FUN_GLOBAL,
  ANCHOR_EVENT_TAG,
  TRADE_EVENT_DISCRIMINATOR,
  NATIVE_SOL_MINT,
} from "./constants";
import { SwapDirection } from "./types";
import {
  lamportsToSOL,
  solToLamports,
  rawToUIAmount,
  isNativeSOL,
  deriveATA,
} from "./utils";

let passed = 0;
let failed = 0;

function assert(condition: boolean, message: string): void {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}`);
    failed++;
  }
}

function assertEq<T>(actual: T, expected: T, message: string): void {
  if (actual === expected) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.error(`  ❌ ${message}: expected ${expected}, got ${actual}`);
    failed++;
  }
}

// =============================================================================
// Test 1: Constants
// =============================================================================
console.log("\n=== Test 1: Constants ===");

assert(
  AXIOM_PROGRAM_ID.toBase58() === "FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9",
  "Axiom Trade program ID is correct"
);

assert(
  PUMP_FUN_PROGRAM_ID.toBase58() ===
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
  "Pump.fun program ID is correct"
);

assert(
  PUMP_FUN_GLOBAL.toBase58() ===
    "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf",
  "Pump.fun global account is correct"
);

assert(
  NATIVE_SOL_MINT.toBase58() ===
    "So11111111111111111111111111111111111111112",
  "Native SOL mint is correct"
);

assert(
  PUMP_FUN_BUY_DISCRIMINATOR.length === 8,
  "Pump.fun buy discriminator is 8 bytes"
);
assert(
  PUMP_FUN_SELL_DISCRIMINATOR.length === 8,
  "Pump.fun sell discriminator is 8 bytes"
);
assert(ANCHOR_EVENT_TAG.length === 8, "Anchor event tag is 8 bytes");
assert(
  TRADE_EVENT_DISCRIMINATOR.length === 8,
  "Trade event discriminator is 8 bytes"
);

// Verify discriminator values
assertEq(
  PUMP_FUN_BUY_DISCRIMINATOR[0],
  102,
  "Buy discriminator first byte is 102"
);
assertEq(
  PUMP_FUN_SELL_DISCRIMINATOR[0],
  51,
  "Sell discriminator first byte is 51"
);

// =============================================================================
// Test 2: Utility functions
// =============================================================================
console.log("\n=== Test 2: Utility functions ===");

assertEq(lamportsToSOL(1_000_000_000), 1.0, "1 billion lamports = 1 SOL");
assertEq(lamportsToSOL(2_961_200_000), 2.9612, "2.9612 SOL conversion");
assertEq(
  lamportsToSOL(BigInt(500_000_000)),
  0.5,
  "0.5 SOL conversion (bigint)"
);

assertEq(
  solToLamports(1.0),
  BigInt(1_000_000_000),
  "1 SOL = 1 billion lamports"
);
assertEq(
  solToLamports(2.9612),
  BigInt(2_961_200_000),
  "2.9612 SOL to lamports"
);

assertEq(
  rawToUIAmount(BigInt(25_342_622_492_742), 6),
  25_342_622.492742,
  "Token amount conversion with 6 decimals"
);
assertEq(
  rawToUIAmount(BigInt(1_000_000), 6),
  1.0,
  "1 token with 6 decimals"
);
assertEq(
  rawToUIAmount(BigInt(1_000_000_000), 9),
  1.0,
  "1 token with 9 decimals"
);

assert(
  isNativeSOL("So11111111111111111111111111111111111111112"),
  "isNativeSOL returns true for WSOL mint"
);
assert(
  isNativeSOL(NATIVE_SOL_MINT),
  "isNativeSOL returns true for WSOL PublicKey"
);
assert(
  !isNativeSOL("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"),
  "isNativeSOL returns false for USDC"
);

// =============================================================================
// Test 3: ATA Derivation
// =============================================================================
console.log("\n=== Test 3: ATA Derivation ===");

const testWallet = new PublicKey(
  "H4K5LjkjXVRBsQXJig3xq9L6co6SfoqRiqnih5iohX9A"
);
const testMint = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);

const ata = deriveATA(testWallet, testMint, "token");
assert(ata instanceof PublicKey, "ATA is a PublicKey");
assert(ata.toBase58().length > 0, "ATA has a valid base58 string");

const ataToken2022 = deriveATA(testWallet, testMint, "token2022");
assert(
  !ata.equals(ataToken2022),
  "Token and Token2022 ATAs are different"
);

// WSOL ATA
const wsolATA = deriveATA(testWallet, NATIVE_SOL_MINT, "token");
assert(wsolATA instanceof PublicKey, "WSOL ATA is a PublicKey");

// =============================================================================
// Test 4: Pump.fun instruction encoding/decoding
// =============================================================================
console.log("\n=== Test 4: Pump.fun instruction encoding ===");

// Encode a buy instruction
const buyData = Buffer.alloc(24);
PUMP_FUN_BUY_DISCRIMINATOR.copy(buyData, 0);
const tokenAmount = BigInt("25342622492742");
buyData.writeBigUInt64LE(tokenAmount, 8);
const maxSolCost = BigInt("2961200000"); // ~2.9612 SOL
buyData.writeBigUInt64LE(maxSolCost, 16);

// Verify encoding
const readDiscriminator = buyData.subarray(0, 8);
assert(
  readDiscriminator.equals(PUMP_FUN_BUY_DISCRIMINATOR),
  "Encoded discriminator matches buy discriminator"
);

const readTokenAmount = buyData.readBigUInt64LE(8);
assertEq(
  readTokenAmount,
  tokenAmount,
  "Encoded token amount matches"
);

const readMaxSolCost = buyData.readBigUInt64LE(16);
assertEq(
  readMaxSolCost,
  maxSolCost,
  "Encoded max SOL cost matches"
);

// Encode a sell instruction
const sellData = Buffer.alloc(24);
PUMP_FUN_SELL_DISCRIMINATOR.copy(sellData, 0);
sellData.writeBigUInt64LE(tokenAmount, 8);
sellData.writeBigUInt64LE(BigInt(0), 16);

const readSellDisc = sellData.subarray(0, 8);
assert(
  readSellDisc.equals(PUMP_FUN_SELL_DISCRIMINATOR),
  "Encoded discriminator matches sell discriminator"
);

// =============================================================================
// Test 5: TradeEvent decoding
// =============================================================================
console.log("\n=== Test 5: TradeEvent decoding ===");

// Simulate a TradeEvent
const tradeEventData = Buffer.alloc(121); // 8 anchor + 8 event disc + 105 event
ANCHOR_EVENT_TAG.copy(tradeEventData, 0);
TRADE_EVENT_DISCRIMINATOR.copy(tradeEventData, 8);

// Write event data at offset 16
let offset = 16;
// Mint (32 bytes) - use a known public key
const testEventMint = new PublicKey(
  "11111111111111111111111111111111"
);
testEventMint.toBuffer().copy(tradeEventData, offset);
offset += 32;

// SOL amount (u64)
tradeEventData.writeBigUInt64LE(BigInt(2961200000), offset);
offset += 8;

// Token amount (u64)
tradeEventData.writeBigUInt64LE(BigInt(25342622492742), offset);
offset += 8;

// is_buy (bool)
tradeEventData[offset] = 1;
offset += 1;

// User (32 bytes)
testWallet.toBuffer().copy(tradeEventData, offset);
offset += 32;

// Timestamp (i64)
tradeEventData.writeBigInt64LE(BigInt(1710862250), offset);
offset += 8;

// Virtual SOL reserves (u64)
tradeEventData.writeBigUInt64LE(BigInt(30000000000), offset);
offset += 8;

// Virtual token reserves (u64)
tradeEventData.writeBigUInt64LE(BigInt(1000000000000000), offset);

// Verify we can read back the event data
assert(
  tradeEventData.subarray(0, 8).equals(ANCHOR_EVENT_TAG),
  "TradeEvent has correct anchor tag"
);
assert(
  tradeEventData.subarray(8, 16).equals(TRADE_EVENT_DISCRIMINATOR),
  "TradeEvent has correct event discriminator"
);

// Read the event fields
const eventOffset = 16;
const eventMint = new PublicKey(
  tradeEventData.subarray(eventOffset, eventOffset + 32)
);
assert(
  eventMint.toBase58() === testEventMint.toBase58(),
  "TradeEvent mint decoded correctly"
);

const eventSolAmount = tradeEventData.readBigUInt64LE(eventOffset + 32);
assertEq(
  eventSolAmount,
  BigInt(2961200000),
  "TradeEvent SOL amount decoded correctly"
);

const eventTokenAmount = tradeEventData.readBigUInt64LE(
  eventOffset + 32 + 8
);
assertEq(
  eventTokenAmount,
  BigInt(25342622492742),
  "TradeEvent token amount decoded correctly"
);

const eventIsBuy = tradeEventData[eventOffset + 32 + 8 + 8] !== 0;
assert(eventIsBuy, "TradeEvent isBuy decoded correctly");

// =============================================================================
// Test 6: SwapDirection enum
// =============================================================================
console.log("\n=== Test 6: SwapDirection ===");

assertEq(
  SwapDirection.SOL_TO_TOKEN,
  "SOL_TO_TOKEN",
  "SOL_TO_TOKEN direction"
);
assertEq(
  SwapDirection.TOKEN_TO_SOL,
  "TOKEN_TO_SOL",
  "TOKEN_TO_SOL direction"
);

// =============================================================================
// Test 7: Pump.fun buy accounts structure
// =============================================================================
console.log("\n=== Test 7: Pump.fun buy accounts ===");

// Derive bonding curve PDA
const testPumpMint = new PublicKey(
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
);
const [bondingCurve] = PublicKey.findProgramAddressSync(
  [Buffer.from("bonding-curve"), testPumpMint.toBuffer()],
  PUMP_FUN_PROGRAM_ID
);
assert(
  bondingCurve instanceof PublicKey,
  "Bonding curve PDA derived successfully"
);

const [eventAuthority] = PublicKey.findProgramAddressSync(
  [Buffer.from("__event_authority")],
  PUMP_FUN_PROGRAM_ID
);
assert(
  eventAuthority instanceof PublicKey,
  "Event authority PDA derived successfully"
);

const [creatorVault] = PublicKey.findProgramAddressSync(
  [Buffer.from("creator-vault"), testPumpMint.toBuffer()],
  PUMP_FUN_PROGRAM_ID
);
assert(
  creatorVault instanceof PublicKey,
  "Creator vault PDA derived successfully"
);

// =============================================================================
// Test 8: bs58 encoding/decoding
// =============================================================================
console.log("\n=== Test 8: bs58 encoding ===");

const testData = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
const encoded = bs58.encode(testData);
assert(typeof encoded === "string", "bs58 encodes to string");

const decoded = Buffer.from(bs58.decode(encoded));
assert(
  decoded.equals(testData),
  "bs58 round-trip encoding/decoding works"
);

// =============================================================================
// Summary
// =============================================================================
console.log("\n=== Test Summary ===");
console.log(`  Passed: ${passed}`);
console.log(`  Failed: ${failed}`);
console.log(`  Total:  ${passed + failed}`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log("\n✅ All tests passed!");
}
