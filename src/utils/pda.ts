import { PublicKey } from "@solana/web3.js";
import {
  PUMPFUN_PROGRAM_ID,
  PUMPFUN_BONDING_CURVE_SEED,
  PUMPFUN_GLOBAL_SEED,
  PUMPFUN_EVENT_AUTHORITY_SEED,
  PUMPFUN_CREATOR_VAULT_SEED,
  PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR_SEED,
  PUMPFUN_USER_VOLUME_ACCUMULATOR_SEED,
  PUMPFUN_FEE_CONFIG_SEED,
  PUMPFUN_FEE_CONFIG_SECOND_SEED,
  PUMPFUN_FEE_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "../constants";

/**
 * Derive the Pump.fun global PDA.
 */
export function derivePumpfunGlobal(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [PUMPFUN_GLOBAL_SEED],
    PUMPFUN_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive the Pump.fun bonding curve PDA for a given mint.
 */
export function derivePumpfunBondingCurve(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [PUMPFUN_BONDING_CURVE_SEED, mint.toBuffer()],
    PUMPFUN_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive the associated token account for the bonding curve
 * (the bonding curve's token account for the mint).
 */
export function derivePumpfunAssociatedBondingCurve(
  bondingCurve: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [bondingCurve.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive the Pump.fun event authority PDA.
 */
export function derivePumpfunEventAuthority(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [PUMPFUN_EVENT_AUTHORITY_SEED],
    PUMPFUN_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive the creator vault PDA given a creator public key.
 */
export function derivePumpfunCreatorVault(creator: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [PUMPFUN_CREATOR_VAULT_SEED, creator.toBuffer()],
    PUMPFUN_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive the global volume accumulator PDA.
 */
export function derivePumpfunGlobalVolumeAccumulator(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [PUMPFUN_GLOBAL_VOLUME_ACCUMULATOR_SEED],
    PUMPFUN_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive the user volume accumulator PDA for a given user.
 */
export function derivePumpfunUserVolumeAccumulator(user: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [PUMPFUN_USER_VOLUME_ACCUMULATOR_SEED, user.toBuffer()],
    PUMPFUN_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive the fee config PDA.
 */
export function derivePumpfunFeeConfig(): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [PUMPFUN_FEE_CONFIG_SEED, PUMPFUN_FEE_CONFIG_SECOND_SEED],
    PUMPFUN_FEE_PROGRAM_ID
  );
  return pda;
}

/**
 * Derive associated token account (ATA) for a wallet + mint.
 */
export function deriveATA(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey = TOKEN_PROGRAM_ID
): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [owner.toBuffer(), tokenProgramId.toBuffer(), mint.toBuffer()],
    ASSOCIATED_TOKEN_PROGRAM_ID
  );
  return pda;
}
