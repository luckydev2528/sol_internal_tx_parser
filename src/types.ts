import { PublicKey, TransactionInstruction } from "@solana/web3.js";

// ─── Swap Direction ────────────────────────────────────────────────────────

export enum SwapDirection {
  SOL_TO_TOKEN = "SOL_TO_TOKEN",
  TOKEN_TO_SOL = "TOKEN_TO_SOL",
}

// ─── DEX Types ─────────────────────────────────────────────────────────────

export enum DexType {
  PUMPFUN = "PUMPFUN",
  PUMPSWAP = "PUMPSWAP",
  UNKNOWN = "UNKNOWN",
}

// ─── Token Program Type ────────────────────────────────────────────────────

export enum TokenProgramType {
  TOKEN = "TOKEN",
  TOKEN_2022 = "TOKEN_2022",
}

// ─── Axiom Instruction Type ────────────────────────────────────────────────

export enum AxiomInstructionType {
  BUY_EXACT_IN = "buy_exact_in",
  SELL_EXACT_IN = "sell_exact_in",
  SELL = "sell",
  BUY = "buy",
  BUY_MAX_OUT = "buy_max_out",
  /** Compact format variant 0: buy via bonding curve (non-Anchor, u8 prefix) */
  COMPACT_BUY = "compact_buy",
  /** Compact format variant 1: sell via bonding curve (non-Anchor, u8 prefix) */
  COMPACT_SELL = "compact_sell",
  UNKNOWN = "unknown",
}

// ─── Parsed Axiom Instruction ──────────────────────────────────────────────

export interface ParsedAxiomInstruction {
  type: AxiomInstructionType;
  direction: SwapDirection;
  dex: DexType;
  mint: PublicKey;
  amountIn: bigint;
  minAmountOut: bigint;
  accounts: AxiomAccountsMap;
  rawData: Buffer;
}

// ─── Axiom Accounts Map ────────────────────────────────────────────────────

export interface AxiomAccountsMap {
  signer: PublicKey;
  mint: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  associatedUser: PublicKey;
  global: PublicKey;
  feeRecipient: PublicKey;
  eventAuthority: PublicKey;
  creatorVault: PublicKey;
  systemProgram: PublicKey;
  tokenProgram: PublicKey;
  dexProgram: PublicKey;
  globalVolumeAccumulator?: PublicKey;
  userVolumeAccumulator?: PublicKey;
  feeConfig?: PublicKey;
  feeProgram?: PublicKey;
}

// ─── Routing Layout ────────────────────────────────────────────────────────

export interface RoutingLayout {
  dex: DexType;
  direction: SwapDirection;
  tokenMint: PublicKey;
  tokenProgramType: TokenProgramType;
  poolOrientation: PoolOrientation;
  accounts: AxiomAccountsMap;
}

// ─── Pool Orientation ──────────────────────────────────────────────────────

export enum PoolOrientation {
  /** SOL is the base token in the pool (SOL/Token) */
  SOL_BASE = "SOL_BASE",
  /** SOL is the quote token in the pool (Token/SOL) */
  SOL_QUOTE = "SOL_QUOTE",
}

// ─── Rebuild Result ────────────────────────────────────────────────────────

export interface RebuildResult {
  instructions: TransactionInstruction[];
  signers: PublicKey[];
  /** Estimated compute units needed */
  computeUnits: number;
  routing: RoutingLayout;
}

// ─── Simulation Result ─────────────────────────────────────────────────────

export interface SimulationResult {
  success: boolean;
  logs: string[];
  unitsConsumed: number;
  error?: string;
  returnData?: {
    programId: string;
    data: string;
  };
}

// ─── Parsed Swap Result (high-level) ───────────────────────────────────────

export interface ParsedSwapResult {
  signature: string;
  signer: string;
  direction: SwapDirection;
  dex: DexType;
  tokenMint: string;
  tokenProgramType: TokenProgramType;
  solAmount: number;
  tokenAmount: number;
  instructionType: AxiomInstructionType;
}
