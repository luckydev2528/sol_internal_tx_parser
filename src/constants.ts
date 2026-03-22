import { PublicKey } from "@solana/web3.js";

// ─── Program IDs ───────────────────────────────────────────────────────────

export const AXIOM_TRADE_PROGRAM_ID = new PublicKey(
  "FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9"
);

export const PUMPFUN_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

export const PUMPFUN_FEE_PROGRAM_ID = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
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

export const SYSTEM_PROGRAM_ID = new PublicKey(
  "11111111111111111111111111111111"
);

export const RENT_PROGRAM_ID = new PublicKey(
  "SysvarRent111111111111111111111111111111111"
);

export const COMPUTE_BUDGET_PROGRAM_ID = new PublicKey(
  "ComputeBudget111111111111111111111111111111"
);

export const NATIVE_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

// ─── Anchor Discriminators ─────────────────────────────────────────────────

export const AXIOM_DISCRIMINATORS = {
  buy_exact_in: Buffer.from([250, 234, 13, 123, 213, 156, 19, 236]),
  sell_exact_in: Buffer.from([149, 39, 222, 155, 211, 124, 152, 26]),
  sell: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
  buy: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
  buy_max_out: Buffer.from([96, 177, 203, 117, 183, 65, 196, 177]),
} as const;

export const PUMPFUN_DISCRIMINATORS = {
  buy: Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]),
  sell: Buffer.from([51, 230, 133, 164, 1, 127, 131, 173]),
} as const;

// ─── Known Pump.fun Addresses ──────────────────────────────────────────────

export const PUMPFUN_GLOBAL_SEED = Buffer.from("global");
export const PUMPFUN_BONDING_CURVE_SEED = Buffer.from("bonding-curve");
export const PUMPFUN_EVENT_AUTHORITY_SEED = Buffer.from("__event_authority");
export const PUMPFUN_CREATOR_VAULT_SEED = Buffer.from("creator-vault");
export const PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR_SEED = Buffer.from(
  "global_volume_accumulator"
);
export const PUMPFUN_USER_VOLUME_ACCUMULATOR_SEED = Buffer.from(
  "user_volume_accumulator"
);
export const PUMPFUN_FEE_CONFIG_SEED = Buffer.from("fee_config");

// Known fee recipient for pump.fun
export const PUMPFUN_FEE_RECIPIENT = new PublicKey(
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbCJt85yjkR7KA"
);

// Fee config second seed (constant from IDL)
export const PUMPFUN_FEE_CONFIG_SECOND_SEED = Buffer.from([
  1, 86, 224, 246, 147, 102, 90, 207, 68, 219, 21, 104, 191, 23, 91, 170, 81,
  137, 203, 151, 245, 210, 255, 59, 101, 93, 43, 182, 253, 109, 24, 176,
]);
