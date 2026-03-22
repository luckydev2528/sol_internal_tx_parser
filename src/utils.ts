import {
  Connection,
  PublicKey,
  TransactionInstruction,
  SystemProgram,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddressSync,
  TOKEN_PROGRAM_ID as SPL_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID as SPL_TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID as SPL_ATA_PROGRAM_ID,
} from "@solana/spl-token";
import {
  NATIVE_SOL_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "./constants";
import { TokenProgramType } from "./types";

/**
 * Detect whether a token uses SPL Token or Token2022 program.
 */
export async function detectTokenProgram(
  connection: Connection,
  mint: PublicKey
): Promise<TokenProgramType> {
  const accountInfo = await connection.getAccountInfo(mint);
  if (!accountInfo) {
    throw new Error(`Mint account not found: ${mint.toBase58()}`);
  }

  if (accountInfo.owner.equals(TOKEN_2022_PROGRAM_ID)) {
    return "token2022";
  }
  return "token";
}

/**
 * Get the correct token program ID for a given token program type.
 */
export function getTokenProgramId(type: TokenProgramType): PublicKey {
  return type === "token2022" ? SPL_TOKEN_2022_PROGRAM_ID : SPL_TOKEN_PROGRAM_ID;
}

/**
 * Derive the Associated Token Account (ATA) for a wallet and mint.
 * Handles both Token and Token2022.
 */
export function deriveATA(
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramType: TokenProgramType
): PublicKey {
  const tokenProgramId = getTokenProgramId(tokenProgramType);
  return getAssociatedTokenAddressSync(mint, owner, true, tokenProgramId);
}

/**
 * Check if an ATA exists on-chain.
 */
export async function ataExists(
  connection: Connection,
  ata: PublicKey
): Promise<boolean> {
  const accountInfo = await connection.getAccountInfo(ata);
  return accountInfo !== null;
}

/**
 * Create an instruction to create an ATA if it doesn't exist.
 */
export function createATAInstruction(
  payer: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramType: TokenProgramType
): TransactionInstruction {
  const tokenProgramId = getTokenProgramId(tokenProgramType);
  const ata = deriveATA(owner, mint, tokenProgramType);

  return new TransactionInstruction({
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: ata, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    programId: SPL_ATA_PROGRAM_ID,
    data: Buffer.alloc(0),
  });
}

/**
 * Create instructions for wrapping SOL into WSOL (native SOL token).
 * Returns:
 * - Create ATA for WSOL
 * - Transfer SOL into the ATA
 * - Sync native balance
 */
export function createWSOLInstructions(
  owner: PublicKey,
  lamports: bigint
): {
  wsolATA: PublicKey;
  instructions: TransactionInstruction[];
} {
  const wsolATA = deriveATA(owner, NATIVE_SOL_MINT, "token");

  const createATAIx = createATAInstruction(
    owner,
    owner,
    NATIVE_SOL_MINT,
    "token"
  );

  const transferIx = SystemProgram.transfer({
    fromPubkey: owner,
    toPubkey: wsolATA,
    lamports,
  });

  // SyncNative instruction (SPL Token program, instruction index 17)
  const syncNativeIx = new TransactionInstruction({
    keys: [{ pubkey: wsolATA, isSigner: false, isWritable: true }],
    programId: SPL_TOKEN_PROGRAM_ID,
    data: Buffer.from([17]),
  });

  return {
    wsolATA,
    instructions: [createATAIx, transferIx, syncNativeIx],
  };
}

/**
 * Create instruction to close a WSOL account (unwrap SOL).
 */
export function createCloseWSOLInstruction(
  owner: PublicKey
): TransactionInstruction {
  const wsolATA = deriveATA(owner, NATIVE_SOL_MINT, "token");

  // CloseAccount instruction (SPL Token program, instruction index 9)
  return new TransactionInstruction({
    keys: [
      { pubkey: wsolATA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    programId: SPL_TOKEN_PROGRAM_ID,
    data: Buffer.from([9]),
  });
}

/**
 * Determine if a mint is native SOL (WSOL).
 */
export function isNativeSOL(mint: PublicKey | string): boolean {
  const mintStr = typeof mint === "string" ? mint : mint.toBase58();
  return mintStr === NATIVE_SOL_MINT.toBase58();
}

/**
 * Convert lamports to SOL.
 */
export function lamportsToSOL(lamports: number | bigint): number {
  return Number(lamports) / 1e9;
}

/**
 * Convert SOL to lamports.
 */
export function solToLamports(sol: number): bigint {
  return BigInt(Math.round(sol * 1e9));
}

/**
 * Convert raw token amount to UI amount based on decimals.
 */
export function rawToUIAmount(raw: bigint, decimals: number): number {
  return Number(raw) / Math.pow(10, decimals);
}
