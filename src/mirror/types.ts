/**
 * Types for outer-only transaction data as received from a live gRPC/LaserStream feed.
 *
 * These types model the MINIMAL data available in a real-time copy-trading bot,
 * which does NOT include inner instructions or parsed metadata.
 */

import { PublicKey } from "@solana/web3.js";

// ─── Raw outer instruction (from gRPC / LaserStream) ───────────────────────

/**
 * A single outer instruction as received from a raw transaction stream.
 * This is what the live bot has access to — NO inner instructions.
 */
export interface RawOuterInstruction {
  /** Index into account_keys identifying the program to invoke */
  programIdIndex: number;
  /** Indices into account_keys for the accounts passed to the instruction */
  accounts: number[];
  /** Raw instruction data (binary) */
  data: Buffer;
}

/**
 * Address Lookup Table reference from a versioned (v0) transaction.
 */
export interface AddressTableLookup {
  accountKey: PublicKey;
  writableIndexes: number[];
  readonlyIndexes: number[];
}

/**
 * Raw outer transaction data as received from the stream.
 * This represents what a gRPC / LaserStream / shred-based bot actually gets.
 */
export interface RawOuterTransaction {
  /** All account keys used by the transaction (static + loaded from ALTs) */
  accountKeys: PublicKey[];
  /** The outer instructions in the transaction */
  instructions: RawOuterInstruction[];
  /** Address table lookups (for v0 transactions) */
  addressTableLookups?: AddressTableLookup[];
  /** Recent blockhash (for rebuild) */
  recentBlockhash?: string;
}

// ─── Mirror result ─────────────────────────────────────────────────────────

/**
 * Result of mirroring an Axiom swap.
 */
export interface MirrorResult {
  /** Whether the mirror was successful */
  success: boolean;
  /** The rebuilt mirrored instructions (if successful) */
  instructions?: import("@solana/web3.js").TransactionInstruction[];
  /** Error message (if failed) */
  error?: string;
  /** Detected swap details */
  swapInfo?: {
    direction: "buy" | "sell";
    tokenMint: string;
    dex: "pumpfun" | "pumpswap" | "unknown";
    originalAmountIn: bigint;
    originalMinAmountOut: bigint;
    mirrorAmountIn: bigint;
    mirrorMinAmountOut: bigint;
    tokenProgramType: "token" | "token2022";
  };
}
