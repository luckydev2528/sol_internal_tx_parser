import { PublicKey } from "@solana/web3.js";

// Axiom Trade program
export const AXIOM_PROGRAM_ID = new PublicKey(
  "FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9"
);

// DEX Program IDs
export const PUMP_FUN_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);
export const PUMPSWAP_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);
export const JUPITER_V6_PROGRAM_ID = new PublicKey(
  "JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4"
);
export const RAYDIUM_V4_PROGRAM_ID = new PublicKey(
  "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8"
);
export const RAYDIUM_CLMM_PROGRAM_ID = new PublicKey(
  "CAMMCzo5YL8w4VFF8KVHrK22GGUsp5VTaW7grrKgrWqK"
);
export const ORCA_WHIRLPOOL_PROGRAM_ID = new PublicKey(
  "whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc"
);
export const METEORA_PROGRAM_ID = new PublicKey(
  "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo"
);
export const METEORA_DLMM_PROGRAM_ID = new PublicKey(
  "Eo7WjKq67rjJQSZxS6z3YkapzY3eMj6Xy8X5EQVn5UG"
);

// Well-known accounts
export const PUMP_FUN_GLOBAL = new PublicKey(
  "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"
);
export const PUMP_FUN_FEE_RECIPIENT = new PublicKey(
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJLGSS81Rg2b"
);

// System programs
export const SYSTEM_PROGRAM_ID = new PublicKey(
  "11111111111111111111111111111111"
);
export const TOKEN_PROGRAM_ID = new PublicKey(
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
);
export const TOKEN_2022_PROGRAM_ID = new PublicKey(
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
);
export const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey(
  "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
);
export const RENT_PROGRAM_ID = new PublicKey(
  "SysvarRent111111111111111111111111111111111"
);
export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  "ComputeBudget111111111111111111111111111111"
);

// SOL/WSOL
export const NATIVE_SOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

// Pump.fun instruction discriminators (first 8 bytes)
export const PUMP_FUN_BUY_DISCRIMINATOR = Buffer.from([
  102, 6, 61, 18, 1, 218, 235, 234,
]);
export const PUMP_FUN_SELL_DISCRIMINATOR = Buffer.from([
  51, 230, 133, 164, 1, 127, 131, 173,
]);

// Anchor event CPI tag and TradeEvent discriminator
export const ANCHOR_EVENT_TAG = Buffer.from("e445a52e51cb9a1d", "hex");
export const TRADE_EVENT_DISCRIMINATOR = Buffer.from(
  "bddb7fd34ee661ee",
  "hex"
);

// Map of known DEX program IDs to platform names
export const DEX_PROGRAMS: Record<string, string> = {
  [PUMP_FUN_PROGRAM_ID.toBase58()]: "pump_fun",
  [PUMPSWAP_PROGRAM_ID.toBase58()]: "pumpswap",
  [JUPITER_V6_PROGRAM_ID.toBase58()]: "jupiter",
  [RAYDIUM_V4_PROGRAM_ID.toBase58()]: "raydium",
  [RAYDIUM_CLMM_PROGRAM_ID.toBase58()]: "raydium_clmm",
  [ORCA_WHIRLPOOL_PROGRAM_ID.toBase58()]: "orca",
  [METEORA_PROGRAM_ID.toBase58()]: "meteora",
  [METEORA_DLMM_PROGRAM_ID.toBase58()]: "meteora_dlmm",
};

// Pump.fun buy instruction account layout (16 accounts)
// Index -> account role
export const PUMP_FUN_BUY_ACCOUNTS = {
  0: "global",
  1: "feeRecipient",
  2: "mint",
  3: "bondingCurve",
  4: "associatedBondingCurve",
  5: "associatedUser",
  6: "user",
  7: "systemProgram",
  8: "tokenProgram",
  9: "creatorVault",
  10: "rent",
  11: "eventAuthority",
  12: "program",
} as const;
