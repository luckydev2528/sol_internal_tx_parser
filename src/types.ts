import { PublicKey } from "@solana/web3.js";

/** Direction of the swap */
export enum SwapDirection {
  SOL_TO_TOKEN = "SOL_TO_TOKEN",
  TOKEN_TO_SOL = "TOKEN_TO_SOL",
}

/** Detected DEX platform */
export type DexPlatform =
  | "pump_fun"
  | "pumpswap"
  | "jupiter"
  | "raydium"
  | "raydium_clmm"
  | "orca"
  | "meteora"
  | "meteora_dlmm"
  | "unknown";

/** Token program variant */
export type TokenProgramType = "token" | "token2022";

/** Parsed swap information extracted from a transaction */
export interface ParsedSwap {
  /** Transaction signature */
  signature: string;
  /** Fee payer / signer wallet */
  signer: string;
  /** Router program that initiated the swap (e.g., Axiom Trade) */
  routerProgram: string;
  /** Underlying DEX platform where the swap was executed */
  platform: DexPlatform;
  /** Swap direction */
  direction: SwapDirection;
  /** Token mint address */
  tokenMint: string;
  /** SOL amount (in SOL, not lamports) */
  solAmount: number;
  /** Token amount (UI amount, adjusted for decimals) */
  tokenAmount: number;
  /** Token decimals */
  tokenDecimals: number;
  /** Token program type */
  tokenProgramType: TokenProgramType;
}

/** Account mapping for a Pump.fun buy instruction */
export interface PumpFunBuyAccounts {
  global: PublicKey;
  feeRecipient: PublicKey;
  mint: PublicKey;
  bondingCurve: PublicKey;
  associatedBondingCurve: PublicKey;
  associatedUser: PublicKey;
  user: PublicKey;
  systemProgram: PublicKey;
  tokenProgram: PublicKey;
  creatorVault: PublicKey;
  rent: PublicKey;
  eventAuthority: PublicKey;
  program: PublicKey;
}

/** Decoded Pump.fun instruction data */
export interface PumpFunInstructionData {
  discriminator: Buffer;
  tokenAmount: bigint;
  maxSolCost: bigint;
}

/** Decoded Pump.fun TradeEvent (from CPI event logs) */
export interface PumpFunTradeEvent {
  mint: PublicKey;
  solAmount: bigint;
  tokenAmount: bigint;
  isBuy: boolean;
  user: PublicKey;
  timestamp: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
}

/** Complete routing info extracted from the transaction */
export interface RoutingInfo {
  /** The parsed swap details */
  swap: ParsedSwap;
  /** Pump.fun-specific account mapping (if applicable) */
  pumpFunAccounts?: PumpFunBuyAccounts;
  /** Pump.fun trade event data (if found in logs) */
  tradeEvent?: PumpFunTradeEvent;
  /** Raw inner instruction indices used by the router */
  innerInstructionIndices: number[];
}

/** Result of instruction rebuild */
export interface RebuiltInstruction {
  /** Serialized transaction (base64) ready for simulation */
  serializedTransaction: string;
  /** The accounts involved */
  accounts: {
    pubkey: string;
    isSigner: boolean;
    isWritable: boolean;
  }[];
  /** Instruction data (hex) */
  data: string;
  /** Program ID */
  programId: string;
}

/** Simulation result */
export interface SimulationResult {
  success: boolean;
  logs: string[];
  unitsConsumed: number;
  error?: string;
}
