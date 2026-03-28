/**
 * Outer Transaction Decoder
 *
 * Decodes Axiom Trade swap instructions from OUTER transaction data ONLY.
 * No inner instructions, no parsed metadata, no token balances.
 *
 * This module reconstructs all swap information from:
 * - instruction.programIdIndex → identifies Axiom Trade program
 * - instruction.accounts        → fixed-layout account positions for Pump.fun routing
 * - instruction.data            → discriminator + amountIn + minAmountOut
 * - transaction.accountKeys     → resolves indices to PublicKeys
 */

import { PublicKey } from "@solana/web3.js";
import {
  AXIOM_TRADE_PROGRAM_ID,
  PUMPFUN_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_2022_PROGRAM_ID,
} from "../constants";
import {
  decodeAxiomDiscriminator,
  decodeCompactInstruction,
  decodeSwapArgs,
} from "../utils/decoder";
import { AxiomInstructionType } from "../types";
import type { RawOuterInstruction, RawOuterTransaction } from "./types";

// ─── Decoded outer instruction result ──────────────────────────────────────

export interface DecodedAxiomOuter {
  /** Instruction type (from discriminator) */
  instructionType: AxiomInstructionType;
  /** Swap direction */
  direction: "buy" | "sell";
  /** Detected DEX */
  dex: "pumpfun" | "pumpswap" | "unknown";
  /** Token mint (from account layout position [2]) */
  tokenMint: PublicKey;
  /** Token program (from account layout position [8]) */
  tokenProgram: PublicKey;
  /** Token program type */
  tokenProgramType: "token" | "token2022";
  /** Original signer (from account layout position [6]) */
  signer: PublicKey;
  /** Amount in (from instruction data) */
  amountIn: bigint;
  /** Minimum amount out (from instruction data) */
  minAmountOut: bigint;
  /** The raw instruction index in the transaction */
  instructionIndex: number;
  /** All resolved account keys for the Axiom instruction */
  resolvedAccounts: PublicKey[];
  /** The full account map for Pump.fun layout */
  pumpfunAccounts: {
    global: PublicKey;
    feeRecipient: PublicKey;
    mint: PublicKey;
    bondingCurve: PublicKey;
    associatedBondingCurve: PublicKey;
    associatedUser: PublicKey;
    signer: PublicKey;
    systemProgram: PublicKey;
    tokenProgram: PublicKey;
    creatorVault: PublicKey;
    eventAuthority: PublicKey;
    dexProgram: PublicKey;
    globalVolumeAccumulator?: PublicKey;
    userVolumeAccumulator?: PublicKey;
    feeConfig?: PublicKey;
    feeProgram?: PublicKey;
  };
  /** Raw outer instruction bytes */
  rawData: Buffer;
}

// ─── Main decode function ──────────────────────────────────────────────────

/**
 * Detect and decode all Axiom Trade instructions from an outer transaction.
 *
 * Works ONLY from outer data — no inner instructions needed.
 *
 * @param tx - Raw outer transaction data (account_keys + instructions)
 * @returns Array of decoded Axiom instructions (may be empty if none found)
 */
export function decodeAxiomOuterInstructions(
  tx: RawOuterTransaction
): DecodedAxiomOuter[] {
  const results: DecodedAxiomOuter[] = [];

  for (let i = 0; i < tx.instructions.length; i++) {
    const ix = tx.instructions[i]!;

    // Check if this instruction targets the Axiom Trade program
    if (ix.programIdIndex >= tx.accountKeys.length) continue;
    const programId = tx.accountKeys[ix.programIdIndex]!;
    if (!programId.equals(AXIOM_TRADE_PROGRAM_ID)) continue;

    // Try to decode this Axiom instruction
    const decoded = decodeAxiomOuterInstruction(ix, tx.accountKeys, i);
    if (decoded) {
      results.push(decoded);
    }
  }

  return results;
}

/**
 * Find the first valid Axiom swap instruction from outer transaction data.
 * Returns null if no Axiom swap instruction is found.
 */
export function findAxiomSwapInstruction(
  tx: RawOuterTransaction
): DecodedAxiomOuter | null {
  const all = decodeAxiomOuterInstructions(tx);

  // Return the first one with a known instruction type (skip UNKNOWN if possible)
  const known = all.find(
    (d) => d.instructionType !== AxiomInstructionType.UNKNOWN
  );
  return known || all[0] || null;
}

/**
 * Check whether an outer transaction contains at least one Axiom Trade instruction.
 */
export function isAxiomTransaction(tx: RawOuterTransaction): boolean {
  for (const ix of tx.instructions) {
    if (ix.programIdIndex >= tx.accountKeys.length) continue;
    const programId = tx.accountKeys[ix.programIdIndex]!;
    if (programId.equals(AXIOM_TRADE_PROGRAM_ID)) return true;
  }
  return false;
}

// ─── Internal decode ───────────────────────────────────────────────────────

/**
 * Decode a single outer Axiom Trade instruction.
 *
 * The key insight: for Pump.fun routing, Axiom uses a FIXED account layout
 * where each position maps to a specific role:
 *
 *   [0]  global
 *   [1]  feeRecipient
 *   [2]  mint
 *   [3]  bondingCurve
 *   [4]  associatedBondingCurve
 *   [5]  associatedUser (user's ATA)
 *   [6]  signer/user
 *   [7]  systemProgram
 *   [8]  tokenProgram
 *   [9]  creatorVault
 *   [10] eventAuthority
 *   [11] dexProgram (Pump.fun / PumpSwap)
 *   [12] globalVolumeAccumulator (optional)
 *   [13] userVolumeAccumulator (optional)
 *   [14] feeConfig (optional)
 *   [15] feeProgram (optional)
 *
 * Direction is determined from the discriminator in instruction.data.
 * Token mint is at position [2].
 * Token program is at position [8] — if Token-2022, ATAs must use that program.
 */
function decodeAxiomOuterInstruction(
  ix: RawOuterInstruction,
  accountKeys: PublicKey[],
  instructionIndex: number
): DecodedAxiomOuter | null {
  const data = ix.data;
  // Minimum data length: 8 bytes discriminator/variant + 8 bytes amountIn + 1 byte overhead
  const MIN_INSTRUCTION_DATA_LENGTH = 17;
  if (data.length < MIN_INSTRUCTION_DATA_LENGTH) return null;

  // Resolve accounts to PublicKeys
  const resolvedAccounts: PublicKey[] = [];
  for (const idx of ix.accounts) {
    if (idx >= accountKeys.length) return null;
    resolvedAccounts.push(accountKeys[idx]!);
  }

  // Need at least 12 accounts for the standard Pump.fun layout
  if (resolvedAccounts.length < 12) return null;

  // --- Decode instruction type and args ---
  let instructionType: AxiomInstructionType;
  let amountIn: bigint;
  let minAmountOut: bigint;

  // Try Anchor 8-byte discriminator first
  const anchorType = decodeAxiomDiscriminator(data);
  if (anchorType !== AxiomInstructionType.UNKNOWN && data.length >= 24) {
    instructionType = anchorType;
    const args = decodeSwapArgs(data);
    amountIn = args.amountIn;
    minAmountOut = args.minAmountOut;
  } else {
    // Try compact format
    const compact = decodeCompactInstruction(data);
    if (compact) {
      instructionType = compact.type;
      amountIn = compact.amountIn;
      minAmountOut = compact.minAmountOut;
    } else {
      // Unknown format — skip this instruction
      return null;
    }
  }

  // --- Determine direction from instruction type ---
  const direction = getDirection(instructionType);
  if (!direction) return null;

  // --- Extract accounts by position ---
  const mint = resolvedAccounts[2]!;
  const tokenProgram = resolvedAccounts[8]!;
  const signer = resolvedAccounts[6]!;
  const dexProgramKey = resolvedAccounts[11]!;

  // --- Detect DEX ---
  const dex = detectDex(dexProgramKey, resolvedAccounts);

  // --- Detect token program type ---
  const tokenProgramType = tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
    ? ("token2022" as const)
    : ("token" as const);

  // --- Build Pump.fun accounts map ---
  const pumpfunAccounts: DecodedAxiomOuter["pumpfunAccounts"] = {
    global: resolvedAccounts[0]!,
    feeRecipient: resolvedAccounts[1]!,
    mint: resolvedAccounts[2]!,
    bondingCurve: resolvedAccounts[3]!,
    associatedBondingCurve: resolvedAccounts[4]!,
    associatedUser: resolvedAccounts[5]!,
    signer: resolvedAccounts[6]!,
    systemProgram: resolvedAccounts[7]!,
    tokenProgram: resolvedAccounts[8]!,
    creatorVault: resolvedAccounts[9]!,
    eventAuthority: resolvedAccounts[10]!,
    dexProgram: resolvedAccounts[11]!,
  };

  if (resolvedAccounts.length > 12) {
    pumpfunAccounts.globalVolumeAccumulator = resolvedAccounts[12];
  }
  if (resolvedAccounts.length > 13) {
    pumpfunAccounts.userVolumeAccumulator = resolvedAccounts[13];
  }
  if (resolvedAccounts.length > 14) {
    pumpfunAccounts.feeConfig = resolvedAccounts[14];
  }
  if (resolvedAccounts.length > 15) {
    pumpfunAccounts.feeProgram = resolvedAccounts[15];
  }

  return {
    instructionType,
    direction,
    dex,
    tokenMint: mint,
    tokenProgram,
    tokenProgramType,
    signer,
    amountIn,
    minAmountOut,
    instructionIndex,
    resolvedAccounts,
    pumpfunAccounts,
    rawData: Buffer.from(data),
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

function getDirection(type: AxiomInstructionType): "buy" | "sell" | null {
  switch (type) {
    case AxiomInstructionType.BUY_EXACT_IN:
    case AxiomInstructionType.BUY:
    case AxiomInstructionType.BUY_MAX_OUT:
    case AxiomInstructionType.COMPACT_BUY:
      return "buy";
    case AxiomInstructionType.SELL_EXACT_IN:
    case AxiomInstructionType.SELL:
    case AxiomInstructionType.COMPACT_SELL:
      return "sell";
    default:
      return null;
  }
}

function detectDex(
  dexProgramKey: PublicKey,
  allAccounts: PublicKey[]
): "pumpfun" | "pumpswap" | "unknown" {
  // Primary: check the expected position [11] (dexProgram)
  if (dexProgramKey.equals(PUMPFUN_PROGRAM_ID)) return "pumpfun";
  if (dexProgramKey.equals(PUMPSWAP_PROGRAM_ID)) return "pumpswap";

  // Fallback: scan all instruction accounts for known DEX program IDs.
  // Compact and non-standard layouts may place the DEX program at a
  // different position.
  for (const acc of allAccounts) {
    if (acc.equals(PUMPFUN_PROGRAM_ID)) return "pumpfun";
    if (acc.equals(PUMPSWAP_PROGRAM_ID)) return "pumpswap";
  }

  return "unknown";
}
