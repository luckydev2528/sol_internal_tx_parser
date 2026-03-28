/**
 * Tests for the mirror module — outer-transaction-only Axiom swap mirroring.
 *
 * These tests validate that the mirror function correctly:
 * 1. Detects Axiom instructions from outer data only
 * 2. Extracts mint, direction, amounts from account positions
 * 3. Remaps signer/ATA to the mirror wallet
 * 4. Handles Token vs Token-2022
 * 5. Scales amounts correctly
 * 6. Builds valid mirrored instructions
 *
 * All tests are offline — no RPC required.
 */

import { Keypair, PublicKey, TransactionInstruction } from "@solana/web3.js";
import {
  AXIOM_TRADE_PROGRAM_ID,
  AXIOM_DISCRIMINATORS,
  PUMPFUN_PROGRAM_ID,
  PUMPFUN_FEE_PROGRAM_ID,
  PUMPFUN_FEE_RECIPIENT,
  PUMPSWAP_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "../constants";
import { AxiomInstructionType } from "../types";
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
import { encodeSwapData, decodeSwapArgs, encodeCompactSwapData } from "../utils/decoder";
import {
  decodeAxiomOuterInstructions,
  findAxiomSwapInstruction,
  isAxiomTransaction,
} from "../mirror/outerTxDecoder";
import { mirrorAxiomSwap } from "../mirror/mirrorAxiomSwap";
import type { RawOuterTransaction, RawOuterInstruction } from "../mirror/types";

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

// ─── Test Fixture: Build a fake Axiom outer transaction ────────────────────

const SAMPLE_MINT = new PublicKey(
  "7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr"
);
const SAMPLE_SIGNER = new PublicKey(
  "H4K5LjkjXVRBsQXJig3xq9L6co6SfoqRiqnih5iohX9A"
);
const SAMPLE_CREATOR = new PublicKey(
  "9YuJb2JnqAjHLUMnywKpLvBkMHYSEaLVFx5RqZA3Dgtu"
);

function buildSampleAxiomTx(
  options: {
    discriminator?: Buffer;
    amountIn?: bigint;
    minAmountOut?: bigint;
    tokenProgramId?: PublicKey;
    signer?: PublicKey;
    mint?: PublicKey;
    dexProgram?: PublicKey;
    extraAccounts?: PublicKey[];
    useCompact?: boolean;
    compactVariant?: number;
  } = {}
): RawOuterTransaction {
  const {
    discriminator = AXIOM_DISCRIMINATORS.buy_exact_in,
    amountIn = BigInt("2961200000"),
    minAmountOut = BigInt("25342622492742"),
    tokenProgramId = TOKEN_PROGRAM_ID,
    signer = SAMPLE_SIGNER,
    mint = SAMPLE_MINT,
    dexProgram = PUMPFUN_PROGRAM_ID,
    extraAccounts = [],
    useCompact = false,
    compactVariant = 0,
  } = options;

  const bondingCurve = derivePumpfunBondingCurve(mint);
  const assocBC = derivePumpfunAssociatedBondingCurve(
    bondingCurve,
    mint,
    tokenProgramId
  );
  const userATA = deriveATA(signer, mint, tokenProgramId);
  const global = derivePumpfunGlobal();
  const eventAuthority = derivePumpfunEventAuthority();
  const creatorVault = derivePumpfunCreatorVault(SAMPLE_CREATOR);
  const globalVolAcc = derivePumpfunGlobalVolumeAccumulator();
  const userVolAcc = derivePumpfunUserVolumeAccumulator(signer);
  const feeConfig = derivePumpfunFeeConfig();

  // Build account keys array (the order here doesn't matter for account keys;
  // the instruction.accounts array maps indices into this)
  const accountKeys: PublicKey[] = [
    signer,                    // 0
    global,                    // 1
    PUMPFUN_FEE_RECIPIENT,     // 2
    mint,                      // 3
    bondingCurve,              // 4
    assocBC,                   // 5
    userATA,                   // 6
    SYSTEM_PROGRAM_ID,         // 7
    tokenProgramId,            // 8
    creatorVault,              // 9
    eventAuthority,            // 10
    dexProgram,                // 11
    globalVolAcc,              // 12
    userVolAcc,                // 13
    feeConfig,                 // 14
    PUMPFUN_FEE_PROGRAM_ID,    // 15
    AXIOM_TRADE_PROGRAM_ID,    // 16 (program being invoked)
    new PublicKey("ComputeBudget111111111111111111111111111111"), // 17
    ...extraAccounts,
  ];

  // Axiom instruction accounts: indices into accountKeys that follow
  // the fixed Pump.fun layout
  const axiomAccounts = [
    1,  // [0] global
    2,  // [1] feeRecipient
    3,  // [2] mint
    4,  // [3] bondingCurve
    5,  // [4] associatedBondingCurve
    6,  // [5] associatedUser
    0,  // [6] signer
    7,  // [7] systemProgram
    8,  // [8] tokenProgram
    9,  // [9] creatorVault
    10, // [10] eventAuthority
    11, // [11] dexProgram
    12, // [12] globalVolumeAccumulator
    13, // [13] userVolumeAccumulator
    14, // [14] feeConfig
    15, // [15] feeProgram
  ];

  // Encode instruction data
  let data: Buffer;
  if (useCompact) {
    data = encodeCompactSwapData(compactVariant, amountIn, minAmountOut);
  } else {
    data = encodeSwapData(discriminator, amountIn, minAmountOut);
  }

  // Compute budget instruction (SetComputeUnitLimit)
  const computeBudgetData = Buffer.alloc(5);
  computeBudgetData.writeUInt8(2, 0);
  computeBudgetData.writeUInt32LE(200_000, 1);

  const instructions: RawOuterInstruction[] = [
    {
      programIdIndex: 17, // ComputeBudget
      accounts: [],
      data: computeBudgetData,
    },
    {
      programIdIndex: 16, // Axiom Trade
      accounts: axiomAccounts,
      data,
    },
  ];

  return { accountKeys, instructions };
}

// ─── Tests ─────────────────────────────────────────────────────────────────

function testIsAxiomTransaction(): void {
  section("isAxiomTransaction");

  const axiomTx = buildSampleAxiomTx();
  assert(isAxiomTransaction(axiomTx), "Detects Axiom transaction");

  // Non-Axiom transaction
  const nonAxiomTx: RawOuterTransaction = {
    accountKeys: [SAMPLE_SIGNER, SYSTEM_PROGRAM_ID],
    instructions: [
      {
        programIdIndex: 1,
        accounts: [0],
        data: Buffer.alloc(10),
      },
    ],
  };
  assert(!isAxiomTransaction(nonAxiomTx), "Rejects non-Axiom transaction");

  // Empty transaction
  const emptyTx: RawOuterTransaction = {
    accountKeys: [],
    instructions: [],
  };
  assert(!isAxiomTransaction(emptyTx), "Rejects empty transaction");
}

function testDecodeAxiomOuterInstructions(): void {
  section("decodeAxiomOuterInstructions — buy_exact_in");

  const tx = buildSampleAxiomTx();
  const decoded = decodeAxiomOuterInstructions(tx);

  assertEqual(decoded.length, 1, "Finds exactly 1 Axiom instruction");

  const d = decoded[0]!;
  assertEqual(
    d.instructionType,
    AxiomInstructionType.BUY_EXACT_IN,
    "Instruction type is buy_exact_in"
  );
  assertEqual(d.direction, "buy", "Direction is buy");
  assertEqual(d.dex, "pumpfun", "DEX is pumpfun");
  assertEqual(
    d.tokenMint.toBase58(),
    SAMPLE_MINT.toBase58(),
    "Token mint extracted correctly"
  );
  assertEqual(
    d.signer.toBase58(),
    SAMPLE_SIGNER.toBase58(),
    "Signer extracted correctly"
  );
  assertEqual(d.amountIn, BigInt("2961200000"), "Amount in decoded correctly");
  assertEqual(
    d.minAmountOut,
    BigInt("25342622492742"),
    "Min amount out decoded correctly"
  );
  assertEqual(
    d.tokenProgramType,
    "token",
    "Token program type is 'token'"
  );
}

function testDecodeAllDiscriminators(): void {
  section("decodeAxiomOuterInstructions — all discriminator types");

  // buy_exact_in
  let tx = buildSampleAxiomTx({ discriminator: AXIOM_DISCRIMINATORS.buy_exact_in });
  let d = findAxiomSwapInstruction(tx)!;
  assertEqual(d.instructionType, AxiomInstructionType.BUY_EXACT_IN, "buy_exact_in detected");
  assertEqual(d.direction, "buy", "buy_exact_in → buy direction");

  // sell_exact_in
  tx = buildSampleAxiomTx({ discriminator: AXIOM_DISCRIMINATORS.sell_exact_in });
  d = findAxiomSwapInstruction(tx)!;
  assertEqual(d.instructionType, AxiomInstructionType.SELL_EXACT_IN, "sell_exact_in detected");
  assertEqual(d.direction, "sell", "sell_exact_in → sell direction");

  // buy
  tx = buildSampleAxiomTx({ discriminator: AXIOM_DISCRIMINATORS.buy });
  d = findAxiomSwapInstruction(tx)!;
  assertEqual(d.instructionType, AxiomInstructionType.BUY, "buy detected");
  assertEqual(d.direction, "buy", "buy → buy direction");

  // sell
  tx = buildSampleAxiomTx({ discriminator: AXIOM_DISCRIMINATORS.sell });
  d = findAxiomSwapInstruction(tx)!;
  assertEqual(d.instructionType, AxiomInstructionType.SELL, "sell detected");
  assertEqual(d.direction, "sell", "sell → sell direction");

  // buy_max_out
  tx = buildSampleAxiomTx({ discriminator: AXIOM_DISCRIMINATORS.buy_max_out });
  d = findAxiomSwapInstruction(tx)!;
  assertEqual(d.instructionType, AxiomInstructionType.BUY_MAX_OUT, "buy_max_out detected");
  assertEqual(d.direction, "buy", "buy_max_out → buy direction");

  // compact buy
  tx = buildSampleAxiomTx({ useCompact: true, compactVariant: 0 });
  d = findAxiomSwapInstruction(tx)!;
  assertEqual(d.instructionType, AxiomInstructionType.COMPACT_BUY, "compact_buy detected");
  assertEqual(d.direction, "buy", "compact_buy → buy direction");

  // compact sell
  tx = buildSampleAxiomTx({ useCompact: true, compactVariant: 1 });
  d = findAxiomSwapInstruction(tx)!;
  assertEqual(d.instructionType, AxiomInstructionType.COMPACT_SELL, "compact_sell detected");
  assertEqual(d.direction, "sell", "compact_sell → sell direction");
}

function testToken2022Detection(): void {
  section("Token-2022 detection from outer accounts");

  const tx = buildSampleAxiomTx({ tokenProgramId: TOKEN_2022_PROGRAM_ID });
  const d = findAxiomSwapInstruction(tx)!;

  assertEqual(
    d.tokenProgramType,
    "token2022",
    "Token-2022 detected from account position [8]"
  );
  assertEqual(
    d.tokenProgram.toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58(),
    "Token program key is Token-2022"
  );
}

function testPumpfunAccountMapping(): void {
  section("Pump.fun account mapping from outer transaction");

  const tx = buildSampleAxiomTx();
  const d = findAxiomSwapInstruction(tx)!;

  const accs = d.pumpfunAccounts;
  assertEqual(
    accs.global.toBase58(),
    derivePumpfunGlobal().toBase58(),
    "Global account correct"
  );
  assertEqual(
    accs.feeRecipient.toBase58(),
    PUMPFUN_FEE_RECIPIENT.toBase58(),
    "Fee recipient correct"
  );
  assertEqual(
    accs.mint.toBase58(),
    SAMPLE_MINT.toBase58(),
    "Mint correct"
  );
  assertEqual(
    accs.bondingCurve.toBase58(),
    derivePumpfunBondingCurve(SAMPLE_MINT).toBase58(),
    "Bonding curve correct"
  );
  assertEqual(
    accs.signer.toBase58(),
    SAMPLE_SIGNER.toBase58(),
    "Signer correct"
  );
  assertEqual(
    accs.dexProgram.toBase58(),
    PUMPFUN_PROGRAM_ID.toBase58(),
    "DEX program correct"
  );
  assert(
    accs.globalVolumeAccumulator instanceof PublicKey,
    "Global volume accumulator present"
  );
  assert(
    accs.userVolumeAccumulator instanceof PublicKey,
    "User volume accumulator present"
  );
  assert(
    accs.feeConfig instanceof PublicKey,
    "Fee config present"
  );
  assert(
    accs.feeProgram instanceof PublicKey,
    "Fee program present"
  );
}

async function testMirrorAxiomSwap(): Promise<void> {
  section("mirrorAxiomSwap — basic buy mirror");

  const sniperTx = buildSampleAxiomTx();
  const myKeypair = Keypair.generate();
  const blockhash = "GfVcyD4kkTrj4bKc7KA39bAEoRncsGnfj7NrTTGVvfBP";

  const result = await mirrorAxiomSwap(sniperTx, myKeypair, blockhash, {
    fixedBuyAmountLamports: BigInt(100_000_000), // 0.1 SOL
    slippageBps: 5000, // 50%
    computeUnitLimit: 200_000,
  });

  assert(result.success, "Mirror result is successful");
  assert(result.instructions !== undefined, "Instructions are generated");
  assert(result.swapInfo !== undefined, "Swap info is present");

  const info = result.swapInfo!;
  assertEqual(info.direction, "buy", "Mirror direction is buy");
  assertEqual(
    info.tokenMint,
    SAMPLE_MINT.toBase58(),
    "Token mint matches"
  );
  assertEqual(info.dex, "pumpfun", "DEX is pumpfun");
  assertEqual(
    info.mirrorAmountIn,
    BigInt(100_000_000),
    "Mirror amount in is fixed at 0.1 SOL"
  );
  assertEqual(
    info.tokenProgramType,
    "token",
    "Token program type is token"
  );

  // Verify the mirror amount out is proportionally scaled with slippage
  // Original: 2961200000 lamports → 25342622492742 tokens
  // Mirror:   100000000 lamports → scaled tokens * (1 - 50% slippage)
  const expectedScaled =
    (BigInt("25342622492742") * BigInt(100_000_000)) / BigInt("2961200000");
  const expectedWithSlippage = (expectedScaled * BigInt(5000)) / BigInt(10000);
  assertEqual(
    info.mirrorMinAmountOut,
    expectedWithSlippage,
    "Mirror min amount out is correctly scaled with slippage"
  );

  // Verify instructions structure
  const ixs = result.instructions!;
  assert(ixs.length >= 2, `At least 2 instructions (got ${ixs.length})`);

  // Find the Axiom swap instruction
  const axiomIx = ixs.find(
    (ix) => ix.programId.toBase58() === AXIOM_TRADE_PROGRAM_ID.toBase58()
  );
  assert(axiomIx !== undefined, "Axiom swap instruction found in output");

  // Verify signer is remapped to my wallet
  const signerKey = axiomIx!.keys[6]!;
  assertEqual(
    signerKey.pubkey.toBase58(),
    myKeypair.publicKey.toBase58(),
    "Signer remapped to mirror wallet"
  );
  assert(signerKey.isSigner, "Mirror wallet is marked as signer");
  assert(signerKey.isWritable, "Mirror wallet is marked as writable");

  // Verify ATA is remapped
  const myATA = deriveATA(myKeypair.publicKey, SAMPLE_MINT, TOKEN_PROGRAM_ID);
  const ataKey = axiomIx!.keys[5]!;
  assertEqual(
    ataKey.pubkey.toBase58(),
    myATA.toBase58(),
    "ATA remapped to mirror wallet's ATA"
  );

  // Verify user volume accumulator is remapped
  if (axiomIx!.keys.length > 13) {
    const myVolAcc = derivePumpfunUserVolumeAccumulator(myKeypair.publicKey);
    assertEqual(
      axiomIx!.keys[13]!.pubkey.toBase58(),
      myVolAcc.toBase58(),
      "User volume accumulator remapped to mirror wallet"
    );
  }

  // Verify non-remapped accounts stay the same
  assertEqual(
    axiomIx!.keys[0]!.pubkey.toBase58(),
    derivePumpfunGlobal().toBase58(),
    "Global account unchanged"
  );
  assertEqual(
    axiomIx!.keys[2]!.pubkey.toBase58(),
    SAMPLE_MINT.toBase58(),
    "Mint unchanged"
  );
  assertEqual(
    axiomIx!.keys[3]!.pubkey.toBase58(),
    derivePumpfunBondingCurve(SAMPLE_MINT).toBase58(),
    "Bonding curve unchanged"
  );
}

async function testMirrorRejectsNonAxiom(): Promise<void> {
  section("mirrorAxiomSwap — rejects non-Axiom transactions");

  const nonAxiomTx: RawOuterTransaction = {
    accountKeys: [SAMPLE_SIGNER, SYSTEM_PROGRAM_ID],
    instructions: [
      {
        programIdIndex: 1,
        accounts: [0],
        data: Buffer.alloc(10),
      },
    ],
  };

  const keypair = Keypair.generate();
  const result = await mirrorAxiomSwap(
    nonAxiomTx,
    keypair,
    "GfVcyD4kkTrj4bKc7KA39bAEoRncsGnfj7NrTTGVvfBP"
  );

  assert(!result.success, "Mirror fails for non-Axiom tx");
  assert(
    (result.error ?? "").includes("Not an Axiom"),
    "Error message mentions non-Axiom"
  );
}

async function testMirrorSellDirection(): Promise<void> {
  section("mirrorAxiomSwap — sell direction");

  const sniperTx = buildSampleAxiomTx({
    discriminator: AXIOM_DISCRIMINATORS.sell_exact_in,
    amountIn: BigInt("10000000000"),
    minAmountOut: BigInt("500000000"),
  });

  const keypair = Keypair.generate();
  const result = await mirrorAxiomSwap(
    sniperTx,
    keypair,
    "GfVcyD4kkTrj4bKc7KA39bAEoRncsGnfj7NrTTGVvfBP",
    { slippageBps: 1000 }
  );

  assert(result.success, "Sell mirror succeeds");
  assertEqual(result.swapInfo?.direction, "sell", "Direction is sell");
  assertEqual(
    result.swapInfo?.mirrorAmountIn,
    BigInt("10000000000"),
    "Sell uses original amount"
  );
}

async function testMirrorWithToken2022(): Promise<void> {
  section("mirrorAxiomSwap — Token-2022");

  const sniperTx = buildSampleAxiomTx({
    tokenProgramId: TOKEN_2022_PROGRAM_ID,
  });

  const keypair = Keypair.generate();
  const result = await mirrorAxiomSwap(
    sniperTx,
    keypair,
    "GfVcyD4kkTrj4bKc7KA39bAEoRncsGnfj7NrTTGVvfBP",
    { fixedBuyAmountLamports: BigInt(50_000_000) }
  );

  assert(result.success, "Token-2022 mirror succeeds");
  assertEqual(
    result.swapInfo?.tokenProgramType,
    "token2022",
    "Token program type is token2022"
  );

  // Verify ATA uses Token-2022
  const axiomIx = result.instructions!.find(
    (ix) => ix.programId.toBase58() === AXIOM_TRADE_PROGRAM_ID.toBase58()
  );
  const expectedATA = deriveATA(
    keypair.publicKey,
    SAMPLE_MINT,
    TOKEN_2022_PROGRAM_ID
  );
  assertEqual(
    axiomIx!.keys[5]!.pubkey.toBase58(),
    expectedATA.toBase58(),
    "ATA uses Token-2022 program"
  );
  assertEqual(
    axiomIx!.keys[8]!.pubkey.toBase58(),
    TOKEN_2022_PROGRAM_ID.toBase58(),
    "Token program key is Token-2022"
  );
}

async function testMirrorCompactFormat(): Promise<void> {
  section("mirrorAxiomSwap — compact instruction format");

  const sniperTx = buildSampleAxiomTx({
    useCompact: true,
    compactVariant: 0, // buy
    amountIn: BigInt("1000000000"),
    minAmountOut: BigInt("5000000000"),
  });

  const keypair = Keypair.generate();
  const result = await mirrorAxiomSwap(
    sniperTx,
    keypair,
    "GfVcyD4kkTrj4bKc7KA39bAEoRncsGnfj7NrTTGVvfBP",
    { fixedBuyAmountLamports: BigInt(200_000_000) }
  );

  assert(result.success, "Compact format mirror succeeds");
  assertEqual(result.swapInfo?.direction, "buy", "Compact buy direction");
  assertEqual(
    result.swapInfo?.mirrorAmountIn,
    BigInt(200_000_000),
    "Compact uses fixed amount"
  );
}

function testEdgeCaseTooFewAccounts(): void {
  section("Edge case: too few accounts");

  const tx: RawOuterTransaction = {
    accountKeys: [
      SAMPLE_SIGNER,
      AXIOM_TRADE_PROGRAM_ID,
      SAMPLE_MINT,
    ],
    instructions: [
      {
        programIdIndex: 1,
        accounts: [0, 2], // Only 2 accounts — too few for Pump.fun layout
        data: encodeSwapData(
          AXIOM_DISCRIMINATORS.buy_exact_in,
          BigInt(100),
          BigInt(200)
        ),
      },
    ],
  };

  const result = findAxiomSwapInstruction(tx);
  assert(result === null, "Returns null for too few accounts");
}

function testEdgeCaseShortData(): void {
  section("Edge case: short instruction data");

  const tx: RawOuterTransaction = {
    accountKeys: [
      SAMPLE_SIGNER,
      AXIOM_TRADE_PROGRAM_ID,
      ...Array(16).fill(SAMPLE_SIGNER).map(() => Keypair.generate().publicKey),
    ],
    instructions: [
      {
        programIdIndex: 1,
        accounts: [0, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
        data: Buffer.alloc(5), // Too short for any format
      },
    ],
  };

  const result = findAxiomSwapInstruction(tx);
  assert(result === null, "Returns null for short instruction data");
}

function testDexDetectionFallback(): void {
  section("DEX detection fallback for compact instructions");

  // Build a compact buy instruction where position [11] in the instruction
  // accounts is NOT the Pump.fun program, but Pump.fun IS referenced at a
  // different position (simulating compact layout differences).
  const randomKey = Keypair.generate().publicKey;
  const global = derivePumpfunGlobal();
  const bondingCurve = derivePumpfunBondingCurve(SAMPLE_MINT);
  const assocBC = derivePumpfunAssociatedBondingCurve(bondingCurve, SAMPLE_MINT, TOKEN_PROGRAM_ID);
  const userATA = deriveATA(SAMPLE_SIGNER, SAMPLE_MINT, TOKEN_PROGRAM_ID);
  const creatorVault = derivePumpfunCreatorVault(SAMPLE_CREATOR);
  const eventAuth = derivePumpfunEventAuthority();
  const globalVolAcc = derivePumpfunGlobalVolumeAccumulator();
  const userVolAcc = derivePumpfunUserVolumeAccumulator(SAMPLE_SIGNER);
  const feeConfig = derivePumpfunFeeConfig();

  // Account keys: position [11] is random, Pump.fun at position [15]
  const accountKeys: PublicKey[] = [
    SAMPLE_SIGNER,                 // 0 - signer
    global,                        // 1 - global
    PUMPFUN_FEE_RECIPIENT,         // 2 - feeRecipient
    SAMPLE_MINT,                   // 3 - mint
    bondingCurve,                  // 4 - bondingCurve
    assocBC,                       // 5 - assocBC
    userATA,                       // 6 - userATA
    SYSTEM_PROGRAM_ID,             // 7 - system
    TOKEN_PROGRAM_ID,              // 8 - token
    creatorVault,                  // 9 - creatorVault
    eventAuth,                     // 10 - eventAuth
    randomKey,                     // 11 - NOT the DEX (random key)
    globalVolAcc,                  // 12 - globalVolAcc
    userVolAcc,                    // 13 - userVolAcc
    feeConfig,                     // 14 - feeConfig
    PUMPFUN_PROGRAM_ID,            // 15 - Pump.fun at non-standard position
    AXIOM_TRADE_PROGRAM_ID,        // 16 - Axiom program
  ];

  // Instruction accounts reference all 16 positions
  const axiomAccounts = [1, 2, 3, 4, 5, 6, 0, 7, 8, 9, 10, 11, 12, 13, 14, 15];
  const data = encodeCompactSwapData(0, BigInt("1000000000"), BigInt("5000000000"));

  const tx: RawOuterTransaction = {
    accountKeys,
    instructions: [{ programIdIndex: 16, accounts: axiomAccounts, data }],
  };

  const d = findAxiomSwapInstruction(tx)!;
  assert(d !== null, "Compact instruction decoded despite non-standard [11]");
  assertEqual(d.instructionType, AxiomInstructionType.COMPACT_BUY, "Compact buy detected");
  assertEqual(d.dex, "pumpfun", "DEX detected via fallback account scan");

  // Same test for PumpSwap at position [15]
  const pumpSwapKeys = [...accountKeys];
  pumpSwapKeys[15] = PUMPSWAP_PROGRAM_ID;
  const txPumpSwap: RawOuterTransaction = {
    accountKeys: pumpSwapKeys,
    instructions: [{ programIdIndex: 16, accounts: axiomAccounts, data }],
  };
  const d2 = findAxiomSwapInstruction(txPumpSwap)!;
  assertEqual(d2.dex, "pumpswap", "PumpSwap detected via fallback account scan");

  // Test that truly unknown DEX stays unknown (no known DEX in any position)
  const unknownKeys = [...accountKeys];
  unknownKeys[15] = Keypair.generate().publicKey;
  const txUnknown: RawOuterTransaction = {
    accountKeys: unknownKeys,
    instructions: [{ programIdIndex: 16, accounts: axiomAccounts, data }],
  };
  const d3 = findAxiomSwapInstruction(txUnknown)!;
  assertEqual(d3.dex, "unknown", "Truly unknown DEX stays unknown");
}

async function testMirrorDefaultAmounts(): Promise<void> {
  section("mirrorAxiomSwap — default (no fixed amount, uses original)");

  const sniperTx = buildSampleAxiomTx({
    amountIn: BigInt("5000000000"), // 5 SOL
    minAmountOut: BigInt("100000000"),
  });

  const keypair = Keypair.generate();
  const result = await mirrorAxiomSwap(
    sniperTx,
    keypair,
    "GfVcyD4kkTrj4bKc7KA39bAEoRncsGnfj7NrTTGVvfBP"
    // No config — should use original amounts
  );

  assert(result.success, "Default amount mirror succeeds");
  assertEqual(
    result.swapInfo?.mirrorAmountIn,
    BigInt("5000000000"),
    "Uses original amount when no fixed amount specified"
  );
}

async function testMirrorInstructionDataEncoding(): Promise<void> {
  section("mirrorAxiomSwap — instruction data encoding");

  const sniperTx = buildSampleAxiomTx({
    discriminator: AXIOM_DISCRIMINATORS.buy_exact_in,
    amountIn: BigInt("2961200000"),
    minAmountOut: BigInt("25342622492742"),
  });

  const keypair = Keypair.generate();
  const result = await mirrorAxiomSwap(
    sniperTx,
    keypair,
    "GfVcyD4kkTrj4bKc7KA39bAEoRncsGnfj7NrTTGVvfBP",
    {
      fixedBuyAmountLamports: BigInt("100000000"),
      slippageBps: 5000,
    }
  );

  assert(result.success, "Instruction data encoding succeeds");

  const axiomIx = result.instructions!.find(
    (ix) => ix.programId.toBase58() === AXIOM_TRADE_PROGRAM_ID.toBase58()
  );

  // Verify the instruction data can be decoded back
  const ixData = axiomIx!.data;
  assert(ixData.length >= 24, "Instruction data is at least 24 bytes");

  // Verify discriminator
  assert(
    Buffer.from(ixData.subarray(0, 8)).equals(AXIOM_DISCRIMINATORS.buy_exact_in),
    "Discriminator matches buy_exact_in"
  );

  // Verify amounts in data
  const decodedArgs = decodeSwapArgs(Buffer.from(ixData));
  assertEqual(
    decodedArgs.amountIn,
    BigInt("100000000"),
    "Encoded amountIn is the mirror amount"
  );
}

// ─── Run All Tests ─────────────────────────────────────────────────────────

async function runTests(): Promise<void> {
  console.log("🧪 Running Mirror Module Tests\n");

  testIsAxiomTransaction();
  testDecodeAxiomOuterInstructions();
  testDecodeAllDiscriminators();
  testToken2022Detection();
  testPumpfunAccountMapping();
  await testMirrorAxiomSwap();
  await testMirrorRejectsNonAxiom();
  await testMirrorSellDirection();
  await testMirrorWithToken2022();
  await testMirrorCompactFormat();
  testEdgeCaseTooFewAccounts();
  testEdgeCaseShortData();
  testDexDetectionFallback();
  await testMirrorDefaultAmounts();
  await testMirrorInstructionDataEncoding();

  console.log(`\n${"═".repeat(50)}`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  console.log(`${"═".repeat(50)}`);

  if (failed > 0) {
    process.exit(1);
  }
}

runTests().catch((err) => {
  console.error("Test runner error:", err);
  process.exit(1);
});
