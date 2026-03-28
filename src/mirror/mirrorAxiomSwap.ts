/**
 * mirrorAxiomSwap – Mirror an Axiom Trade swap from OUTER transaction data only.
 *
 * This is the core function for copy-trading Axiom-routed swaps. It works
 * exclusively from outer transaction data as received from a live gRPC /
 * LaserStream / shred-based feed. It does NOT use inner instructions, parsed
 * metadata, or token balance snapshots.
 *
 * Flow:
 *   1. Detect the Axiom Trade instruction from outer instructions
 *   2. Extract mint, direction, amounts from the fixed account layout + data
 *   3. Remap signer → mirror wallet, re-derive ATA + user volume accumulator
 *   4. Determine Token vs Token-2022 from the outer account at position [8]
 *   5. Scale amount_in / min_out to the mirror wallet's desired amount
 *   6. Rebuild a complete mirrored transaction
 *
 * The function signature follows the user's Rust-style naming convention:
 *   mirror_axiom_swap(sniper_tx, keypair, latest_blockhash)
 *
 * @module mirror/mirrorAxiomSwap
 */

import {
  Connection,
  Keypair,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AccountMeta,
} from "@solana/web3.js";
import {
  AXIOM_TRADE_PROGRAM_ID,
  AXIOM_DISCRIMINATORS,
  COMPUTE_BUDGET_PROGRAM_ID,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  PUMPFUN_PROGRAM_ID,
  PUMPSWAP_PROGRAM_ID,
  PUMPFUN_FEE_PROGRAM_ID,
  PUMPFUN_FEE_RECIPIENT,
} from "../constants";
import {
  deriveATA,
  derivePumpfunBondingCurve,
  derivePumpfunAssociatedBondingCurve,
  derivePumpfunGlobal,
  derivePumpfunEventAuthority,
  derivePumpfunCreatorVault,
  derivePumpfunGlobalVolumeAccumulator,
  derivePumpfunUserVolumeAccumulator,
  derivePumpfunFeeConfig,
} from "../utils/pda";
import { encodeSwapData, encodeCompactSwapData, writeU64LE } from "../utils/decoder";
import { AxiomInstructionType } from "../types";
import {
  findAxiomSwapInstruction,
  isAxiomTransaction,
  type DecodedAxiomOuter,
} from "./outerTxDecoder";
import type {
  RawOuterTransaction,
  RawOuterInstruction,
  MirrorResult,
} from "./types";

// ─── Configuration ─────────────────────────────────────────────────────────

export interface MirrorConfig {
  /**
   * Fixed SOL amount for mirror buys (in lamports).
   * Only applies to buy direction — sell direction always uses original amounts.
   * If not set, uses the original sniper's amount.
   * Example: BigInt(100_000_000) for 0.1 SOL.
   */
  fixedBuyAmountLamports?: bigint;

  /**
   * Slippage tolerance in basis points (e.g., 500 = 5%).
   * Used to calculate minAmountOut for buys.
   * Default: 5000 (50% — aggressive for meme coins).
   */
  slippageBps?: number;

  /**
   * Compute unit limit for the transaction.
   * Default: 200_000.
   */
  computeUnitLimit?: number;

  /**
   * Compute unit price in micro-lamports.
   * Default: undefined (no priority fee added).
   */
  computeUnitPrice?: bigint;

  /**
   * Whether to include an ATA create-idempotent instruction.
   * Default: true.
   */
  createATA?: boolean;

  /**
   * Optional connection for fetching the bonding curve creator
   * when the creator vault cannot be derived from the sniper tx.
   */
  connection?: Connection;
}

// ─── Main Function ─────────────────────────────────────────────────────────

/**
 * Mirror an Axiom Trade swap using ONLY outer transaction data.
 *
 * @param sniperTx       - The raw outer transaction from the sniper/whale
 * @param keypair        - Your wallet keypair
 * @param latestBlockhash - Recent blockhash for the mirrored transaction
 * @param config         - Mirror configuration (amounts, slippage, etc.)
 * @returns MirrorResult with the rebuilt transaction or error
 */
export async function mirrorAxiomSwap(
  sniperTx: RawOuterTransaction,
  keypair: Keypair,
  latestBlockhash: string,
  config: MirrorConfig = {}
): Promise<MirrorResult> {
  // --- 1. Detect Axiom instruction from outer data ---
  if (!isAxiomTransaction(sniperTx)) {
    return { success: false, error: "Not an Axiom Trade transaction" };
  }

  const decoded = findAxiomSwapInstruction(sniperTx);
  if (!decoded) {
    return {
      success: false,
      error: "No decodable Axiom swap instruction found in outer transaction",
    };
  }

  // --- 2. Only mirror buys (copy-trading typically mirrors buys) ---
  // Sells can also be mirrored if desired; direction is passed through.
  const { direction, dex } =
    decoded;

  // --- 3. Calculate mirror amounts ---
  const {
    fixedBuyAmountLamports,
    slippageBps = 5000,
    computeUnitLimit = 200_000,
    computeUnitPrice,
    createATA = true,
  } = config;
  const shouldCreateATA = createATA && dex !== "pumpswap";

  let mirrorAmountIn: bigint;
  let mirrorMinAmountOut: bigint;

  if (direction === "buy") {
    // For buys: use fixed amount or scale from original
    mirrorAmountIn =
      fixedBuyAmountLamports ?? decoded.amountIn;

    // Scale minAmountOut proportionally then apply slippage
    if (decoded.amountIn > 0n) {
      const scaledOut =
        (decoded.minAmountOut * mirrorAmountIn) / decoded.amountIn;
      // Apply slippage reduction
      mirrorMinAmountOut =
        (scaledOut * BigInt(10000 - slippageBps)) / BigInt(10000);
    } else {
      mirrorMinAmountOut = 0n;
    }
  } else {
    // For sells: use original amounts (or override if needed)
    mirrorAmountIn = decoded.amountIn;
    mirrorMinAmountOut =
      (decoded.minAmountOut * BigInt(10000 - slippageBps)) / BigInt(10000);
  }

  // --- 4. Build mirrored instructions ---
  const myWallet = keypair.publicKey;
  const tokenContext = await resolveTradeTokenContext(decoded, config.connection);
  const tokenMint = tokenContext.mint;
  const tokenProgramId = tokenContext.tokenProgramId;
  const resolvedTokenProgramType = tokenProgramId.equals(TOKEN_2022_PROGRAM_ID)
    ? "token2022"
    : "token";

  const instructions: TransactionInstruction[] = [];

  // 4a. Compute budget
  instructions.push(createSetComputeUnitLimitIx(computeUnitLimit));
  if (computeUnitPrice !== undefined) {
    instructions.push(createSetComputeUnitPriceIx(computeUnitPrice));
  }

  // 4b. Create ATA for the token (idempotent)
  if (shouldCreateATA) {
    const myATA = deriveATA(myWallet, tokenMint, tokenProgramId);
    instructions.push(
      createATAIdempotentIx(myWallet, myATA, myWallet, tokenMint, tokenProgramId)
    );
  }

  // 4c. Build the Axiom Trade swap instruction with remapped accounts
  const swapIx = await buildMirroredSwapIx(
    decoded,
    myWallet,
    mirrorAmountIn,
    mirrorMinAmountOut,
    tokenMint,
    tokenProgramId,
    tokenContext.signerOwnedTokenAccounts,
    config.connection,
  );
  instructions.push(swapIx);

  // --- 5. Build the versioned transaction ---
  const messageV0 = new TransactionMessage({
    payerKey: myWallet,
    recentBlockhash: latestBlockhash,
    instructions,
  }).compileToV0Message();

  const transaction = new VersionedTransaction(messageV0);
  transaction.sign([keypair]);

  return {
    success: true,
    instructions,
    swapInfo: {
      direction,
      tokenMint: tokenMint.toBase58(),
      dex,
      originalAmountIn: decoded.amountIn,
      originalMinAmountOut: decoded.minAmountOut,
      mirrorAmountIn,
      mirrorMinAmountOut,
      tokenProgramType: resolvedTokenProgramType,
    },
  };
}

// ─── Convenience: Parse from VersionedTransaction ──────────────────────────

/**
 * Convert a VersionedTransaction (as received from LaserStream / gRPC)
 * into the RawOuterTransaction format expected by mirrorAxiomSwap.
 *
 * This is the bridge between the on-chain transaction format and our
 * outer-only processing. The returned object contains ONLY the outer
 * message data — no inner instructions.
 */
export function versionedTxToRawOuter(
  tx: VersionedTransaction,
  resolvedAccountKeys?: PublicKey[]
): RawOuterTransaction {
  const message = tx.message;

  // Static account keys from the message
  const staticKeys = message.staticAccountKeys;

  // If caller provides fully resolved keys (static + ALT loaded), use those.
  // Otherwise use only static keys (ALT resolution must happen separately).
  const accountKeys = resolvedAccountKeys || staticKeys;

  const instructions: RawOuterInstruction[] =
    message.compiledInstructions.map((cix) => ({
      programIdIndex: cix.programIdIndex,
      accounts: Array.from(cix.accountKeyIndexes),
      data: Buffer.from(cix.data),
    }));

  const addressTableLookups = message.addressTableLookups.map((lookup) => ({
    accountKey: lookup.accountKey,
    writableIndexes: Array.from(lookup.writableIndexes),
    readonlyIndexes: Array.from(lookup.readonlyIndexes),
  }));

  return {
    accountKeys,
    instructions,
    addressTableLookups:
      addressTableLookups.length > 0 ? addressTableLookups : undefined,
  };
}

// ─── Build the mirrored swap instruction ───────────────────────────────────

async function buildMirroredSwapIx(
  decoded: DecodedAxiomOuter,
  myWallet: PublicKey,
  amountIn: bigint,
  minAmountOut: bigint,
  tokenMint: PublicKey,
  tokenProgramId: PublicKey,
  signerOwnedTokenAccounts: SignerOwnedTokenAccountInfo[],
  connection?: Connection,
): Promise<TransactionInstruction> {
  const { pumpfunAccounts, instructionType } = decoded;
  if (decoded.dex === "pumpswap") {
    return buildMirroredPumpSwapIx(
      decoded,
      myWallet,
      tokenMint,
      tokenProgramId,
      signerOwnedTokenAccounts
    );
  }

  // Derive remapped accounts for my wallet
  const myATA = deriveATA(myWallet, tokenMint, tokenProgramId);
  const myUserVolumeAccumulator = derivePumpfunUserVolumeAccumulator(myWallet);

  // For the creator vault, we need the creator address.
  // Strategy: extract the bonding curve from the sniper tx accounts, then
  // derive the creator vault. The bonding curve is at position [3] and the
  // creator vault is at position [9]. Since the creator vault PDA is
  // `PDA(["creator-vault", creator], pump_fun_program)` and we can't
  // reverse a PDA to get the creator, we use the SAME creator vault from
  // the sniper tx — it is per-token, not per-user.
  const creatorVault = pumpfunAccounts.creatorVault;

  // Encode instruction data
  const data = encodeInstructionData(instructionType, amountIn, minAmountOut);

  // Build accounts list — same layout as the original, with wallet remapped
  const accounts: AccountMeta[] = [
    { pubkey: pumpfunAccounts.global, isSigner: false, isWritable: false },
    { pubkey: pumpfunAccounts.feeRecipient, isSigner: false, isWritable: true },
    { pubkey: tokenMint, isSigner: false, isWritable: true },
    { pubkey: pumpfunAccounts.bondingCurve, isSigner: false, isWritable: true },
    { pubkey: pumpfunAccounts.associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: myATA, isSigner: false, isWritable: true },
    { pubkey: myWallet, isSigner: true, isWritable: true },
    { pubkey: pumpfunAccounts.systemProgram, isSigner: false, isWritable: false },
    { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    { pubkey: creatorVault, isSigner: false, isWritable: true },
    { pubkey: pumpfunAccounts.eventAuthority, isSigner: false, isWritable: false },
    { pubkey: pumpfunAccounts.dexProgram, isSigner: false, isWritable: false },
  ];

  // Optional accounts
  if (pumpfunAccounts.globalVolumeAccumulator) {
    accounts.push({
      pubkey: pumpfunAccounts.globalVolumeAccumulator,
      isSigner: false,
      isWritable: true,
    });
  }
  if (pumpfunAccounts.userVolumeAccumulator) {
    // Remap user volume accumulator to our wallet
    accounts.push({
      pubkey: myUserVolumeAccumulator,
      isSigner: false,
      isWritable: true,
    });
  }
  if (pumpfunAccounts.feeConfig) {
    accounts.push({
      pubkey: pumpfunAccounts.feeConfig,
      isSigner: false,
      isWritable: false,
    });
  }
  if (pumpfunAccounts.feeProgram) {
    accounts.push({
      pubkey: pumpfunAccounts.feeProgram,
      isSigner: false,
      isWritable: false,
    });
  }

  return new TransactionInstruction({
    programId: AXIOM_TRADE_PROGRAM_ID,
    keys: accounts,
    data,
  });
}

function buildMirroredPumpSwapIx(
  decoded: DecodedAxiomOuter,
  myWallet: PublicKey,
  tokenMint: PublicKey,
  tokenProgramId: PublicKey,
  signerOwnedTokenAccounts: SignerOwnedTokenAccountInfo[]
): TransactionInstruction {
  const myTokenATA = deriveATA(myWallet, tokenMint, tokenProgramId);
  const myWsolATA = deriveATA(myWallet, NATIVE_MINT, TOKEN_PROGRAM_ID);
  const sourceSigner = decoded.signer;

  const remappedAccounts = decoded.resolvedAccounts.map((account) => {
    if (account.equals(sourceSigner)) {
      return myWallet;
    }
    const signerToken = signerOwnedTokenAccounts.find((a) =>
      a.address.equals(account)
    );
    if (!signerToken) {
      return account;
    }
    if (signerToken.mint.equals(tokenMint)) {
      return myTokenATA;
    }
    if (signerToken.mint.equals(NATIVE_MINT)) {
      return myWsolATA;
    }
    return account;
  });

  const keys: AccountMeta[] = remappedAccounts.map((pubkey) => ({
    pubkey,
    isSigner: pubkey.equals(myWallet),
    isWritable: !isKnownReadonlyProgram(pubkey),
  }));

  return new TransactionInstruction({
    programId: AXIOM_TRADE_PROGRAM_ID,
    keys,
    data: Buffer.from(decoded.rawData),
  });
}

// ─── Encode instruction data ───────────────────────────────────────────────

function encodeInstructionData(
  instructionType: AxiomInstructionType,
  amountIn: bigint,
  minAmountOut: bigint
): Buffer {
  switch (instructionType) {
    case AxiomInstructionType.BUY_EXACT_IN:
      return encodeSwapData(
        AXIOM_DISCRIMINATORS.buy_exact_in,
        amountIn,
        minAmountOut
      );
    case AxiomInstructionType.SELL_EXACT_IN:
      return encodeSwapData(
        AXIOM_DISCRIMINATORS.sell_exact_in,
        amountIn,
        minAmountOut
      );
    case AxiomInstructionType.BUY:
      return encodeSwapData(
        AXIOM_DISCRIMINATORS.buy,
        amountIn,
        minAmountOut
      );
    case AxiomInstructionType.SELL:
      return encodeSwapData(
        AXIOM_DISCRIMINATORS.sell,
        amountIn,
        minAmountOut
      );
    case AxiomInstructionType.BUY_MAX_OUT:
      return encodeSwapData(
        AXIOM_DISCRIMINATORS.buy_max_out,
        amountIn,
        minAmountOut
      );
    case AxiomInstructionType.COMPACT_BUY:
      return encodeCompactSwapData(0, amountIn, minAmountOut);
    case AxiomInstructionType.COMPACT_SELL:
      return encodeCompactSwapData(1, amountIn, minAmountOut);
    default:
      // Default to buy_exact_in for unknown types
      return encodeSwapData(
        AXIOM_DISCRIMINATORS.buy_exact_in,
        amountIn,
        minAmountOut
      );
  }
}

// ─── Compute Budget helpers ────────────────────────────────────────────────

function createSetComputeUnitLimitIx(units: number): TransactionInstruction {
  const data = Buffer.alloc(5);
  data.writeUInt8(2, 0);
  data.writeUInt32LE(units, 1);
  return new TransactionInstruction({
    programId: new PublicKey("ComputeBudget111111111111111111111111111111"),
    keys: [],
    data,
  });
}

function createSetComputeUnitPriceIx(
  microLamports: bigint
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0);
  data.writeBigUInt64LE(microLamports, 1);
  return new TransactionInstruction({
    programId: new PublicKey("ComputeBudget111111111111111111111111111111"),
    keys: [],
    data,
  });
}

// ─── ATA create-idempotent helper ──────────────────────────────────────────

function createATAIdempotentIx(
  payer: PublicKey,
  associatedToken: PublicKey,
  owner: PublicKey,
  mint: PublicKey,
  tokenProgramId: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: ASSOCIATED_TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: payer, isSigner: true, isWritable: true },
      { pubkey: associatedToken, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: false },
      { pubkey: mint, isSigner: false, isWritable: false },
      { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    ],
    data: Buffer.from([1]), // CreateIdempotent
  });
}

async function resolveTokenProgramId(
  decoded: DecodedAxiomOuter,
  connection?: Connection
): Promise<PublicKey> {
  // Prefer the outer instruction's token program account when it is valid.
  if (
    decoded.tokenProgram.equals(TOKEN_PROGRAM_ID) ||
    decoded.tokenProgram.equals(TOKEN_2022_PROGRAM_ID)
  ) {
    return decoded.tokenProgram;
  }

  // For layouts that don't place tokenProgram at the expected position,
  // derive from mint owner when RPC connection is available.
  if (connection) {
    const mintInfo = await connection.getAccountInfo(decoded.tokenMint, "confirmed");
    if (mintInfo?.owner.equals(TOKEN_2022_PROGRAM_ID)) {
      return TOKEN_2022_PROGRAM_ID;
    }
  }

  return decoded.tokenProgramType === "token2022"
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
}

interface SignerOwnedTokenAccountInfo {
  address: PublicKey;
  mint: PublicKey;
  tokenProgramId: PublicKey;
}

async function resolveTradeTokenContext(
  decoded: DecodedAxiomOuter,
  connection?: Connection
): Promise<{
  mint: PublicKey;
  tokenProgramId: PublicKey;
  signerOwnedTokenAccounts: SignerOwnedTokenAccountInfo[];
}> {
  const fallbackTokenProgramId = await resolveTokenProgramId(decoded, connection);
  if (!connection || decoded.dex !== "pumpswap") {
    return {
      mint: decoded.tokenMint,
      tokenProgramId: fallbackTokenProgramId,
      signerOwnedTokenAccounts: [],
    };
  }

  const signerOwnedTokenAccounts = await fetchSignerOwnedTokenAccounts(
    connection,
    decoded.resolvedAccounts,
    decoded.signer
  );
  const nonNative = signerOwnedTokenAccounts.find(
    (a) => !a.mint.equals(NATIVE_MINT)
  );
  if (nonNative) {
    return {
      mint: nonNative.mint,
      tokenProgramId: nonNative.tokenProgramId,
      signerOwnedTokenAccounts,
    };
  }

  return {
    mint: decoded.tokenMint,
    tokenProgramId: fallbackTokenProgramId,
    signerOwnedTokenAccounts,
  };
}

async function fetchSignerOwnedTokenAccounts(
  connection: Connection,
  accounts: PublicKey[],
  sourceSigner: PublicKey
): Promise<SignerOwnedTokenAccountInfo[]> {
  const infos = await connection.getMultipleAccountsInfo(accounts, "confirmed");
  const result: SignerOwnedTokenAccountInfo[] = [];

  for (let i = 0; i < accounts.length; i++) {
    const info = infos[i];
    if (!info) continue;
    const isTokenProgram =
      info.owner.equals(TOKEN_PROGRAM_ID) || info.owner.equals(TOKEN_2022_PROGRAM_ID);
    if (!isTokenProgram || info.data.length < 64) continue;

    const mint = new PublicKey(info.data.subarray(0, 32));
    const owner = new PublicKey(info.data.subarray(32, 64));
    if (!owner.equals(sourceSigner)) continue;

    result.push({
      address: accounts[i]!,
      mint,
      tokenProgramId: info.owner,
    });
  }

  return result;
}

function isKnownReadonlyProgram(pubkey: PublicKey): boolean {
  return (
    pubkey.equals(SYSTEM_PROGRAM_ID) ||
    pubkey.equals(TOKEN_PROGRAM_ID) ||
    pubkey.equals(TOKEN_2022_PROGRAM_ID) ||
    pubkey.equals(ASSOCIATED_TOKEN_PROGRAM_ID) ||
    pubkey.equals(AXIOM_TRADE_PROGRAM_ID) ||
    pubkey.equals(PUMPFUN_PROGRAM_ID) ||
    pubkey.equals(PUMPSWAP_PROGRAM_ID) ||
    pubkey.equals(PUMPFUN_FEE_PROGRAM_ID) ||
    pubkey.equals(COMPUTE_BUDGET_PROGRAM_ID)
  );
}
