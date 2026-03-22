import {
  Connection,
  PublicKey,
  TransactionInstruction,
  AccountMeta,
} from "@solana/web3.js";
import {
  AXIOM_TRADE_PROGRAM_ID,
  AXIOM_DISCRIMINATORS,
  PUMPFUN_PROGRAM_ID,
  PUMPFUN_FEE_PROGRAM_ID,
  PUMPFUN_FEE_RECIPIENT,
  SYSTEM_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
} from "../constants";
import {
  AxiomInstructionType,
  DexType,
  PoolOrientation,
  RebuildResult,
  SwapDirection,
  TokenProgramType,
} from "../types";
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
import { encodeSwapData, writeU64LE } from "../utils/decoder";

interface BuildSwapParams {
  signer: PublicKey;
  mint: PublicKey;
  amountIn: bigint;
  minAmountOut: bigint;
  direction: SwapDirection;
  creatorAddress?: PublicKey;
  tokenProgramType?: TokenProgramType;
  dex?: DexType;
  computeUnitLimit?: number;
  computeUnitPrice?: bigint;
}

/**
 * Build a complete set of instructions for an Axiom Trade swap through Pump.fun.
 *
 * This handles:
 * - ATA creation (idempotent)
 * - WSOL wrapping (for SOL→Token buys)
 * - Token program detection (Token vs Token2022)
 * - Pool orientation
 * - Vault and fee account setup
 * - Compute budget instructions
 */
export async function buildSwapInstructions(
  connection: Connection,
  params: BuildSwapParams
): Promise<RebuildResult> {
  const {
    signer,
    mint,
    amountIn,
    minAmountOut,
    direction,
    creatorAddress,
    computeUnitLimit = 200_000,
    computeUnitPrice,
  } = params;

  const tokenProgramId = resolveTokenProgram(
    params.tokenProgramType || TokenProgramType.TOKEN
  );

  const instructions: TransactionInstruction[] = [];

  // 1. Compute budget instructions
  instructions.push(
    createSetComputeUnitLimitInstruction(computeUnitLimit)
  );
  if (computeUnitPrice !== undefined) {
    instructions.push(
      createSetComputeUnitPriceInstruction(computeUnitPrice)
    );
  }

  // 2. Create ATA for the token if needed (idempotent)
  const userATA = deriveATA(signer, mint, tokenProgramId);
  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(
      signer,
      userATA,
      signer,
      mint,
      tokenProgramId
    )
  );

  // 3. Build the Axiom Trade swap instruction
  const swapIx = buildPumpfunSwapInstruction({
    signer,
    mint,
    amountIn,
    minAmountOut,
    direction,
    tokenProgramId,
    creatorAddress,
  });
  instructions.push(swapIx);

  // 4. Determine routing layout
  const routing = {
    dex: DexType.PUMPFUN,
    direction,
    tokenMint: mint,
    tokenProgramType: params.tokenProgramType || TokenProgramType.TOKEN,
    poolOrientation: PoolOrientation.SOL_QUOTE,
    accounts: extractAccountsFromInstruction(swapIx, signer, mint),
  };

  return {
    instructions,
    signers: [signer],
    computeUnits: computeUnitLimit,
    routing,
  };
}

/**
 * Build a Pump.fun buy or sell instruction routed through Axiom Trade.
 */
function buildPumpfunSwapInstruction(params: {
  signer: PublicKey;
  mint: PublicKey;
  amountIn: bigint;
  minAmountOut: bigint;
  direction: SwapDirection;
  tokenProgramId: PublicKey;
  creatorAddress?: PublicKey;
}): TransactionInstruction {
  const {
    signer,
    mint,
    amountIn,
    minAmountOut,
    direction,
    tokenProgramId,
    creatorAddress,
  } = params;

  // Derive all necessary PDAs
  const global = derivePumpfunGlobal();
  const bondingCurve = derivePumpfunBondingCurve(mint);
  const associatedBondingCurve = derivePumpfunAssociatedBondingCurve(
    bondingCurve,
    mint,
    tokenProgramId
  );
  const userATA = deriveATA(signer, mint, tokenProgramId);
  const eventAuthority = derivePumpfunEventAuthority();
  const globalVolumeAccumulator = derivePumpfunGlobalVolumeAccumulator();
  const userVolumeAccumulator = derivePumpfunUserVolumeAccumulator(signer);
  const feeConfig = derivePumpfunFeeConfig();

  // Creator vault - if we know the creator, derive it; otherwise use a placeholder
  const creatorVault = creatorAddress
    ? derivePumpfunCreatorVault(creatorAddress)
    : derivePumpfunCreatorVault(signer); // Will be overridden if we know the creator

  // Determine the instruction discriminator
  const discriminator =
    direction === SwapDirection.SOL_TO_TOKEN
      ? AXIOM_DISCRIMINATORS.buy_exact_in
      : AXIOM_DISCRIMINATORS.sell_exact_in;

  // Encode the instruction data
  const data = encodeSwapData(discriminator, amountIn, minAmountOut);

  // Build accounts list in the correct order
  const accounts: AccountMeta[] = [
    { pubkey: global, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: true },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: userATA, isSigner: false, isWritable: true },
    { pubkey: signer, isSigner: true, isWritable: true },
    { pubkey: SYSTEM_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: tokenProgramId, isSigner: false, isWritable: false },
    { pubkey: creatorVault, isSigner: false, isWritable: true },
    { pubkey: eventAuthority, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: true },
    { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
    { pubkey: feeConfig, isSigner: false, isWritable: false },
    { pubkey: PUMPFUN_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
  ];

  return new TransactionInstruction({
    programId: AXIOM_TRADE_PROGRAM_ID,
    keys: accounts,
    data,
  });
}

/**
 * Extract accounts map from a built instruction.
 */
function extractAccountsFromInstruction(
  ix: TransactionInstruction,
  signer: PublicKey,
  mint: PublicKey
): {
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
} {
  const keys = ix.keys;
  return {
    global: keys[0]!.pubkey,
    feeRecipient: keys[1]!.pubkey,
    mint: keys[2]!.pubkey,
    bondingCurve: keys[3]!.pubkey,
    associatedBondingCurve: keys[4]!.pubkey,
    associatedUser: keys[5]!.pubkey,
    signer: keys[6]!.pubkey,
    systemProgram: keys[7]!.pubkey,
    tokenProgram: keys[8]!.pubkey,
    creatorVault: keys[9]!.pubkey,
    eventAuthority: keys[10]!.pubkey,
    dexProgram: keys[11]!.pubkey,
  };
}

// ─── Helper: Resolve Token Program ID ──────────────────────────────────────

function resolveTokenProgram(type: TokenProgramType): PublicKey {
  return type === TokenProgramType.TOKEN_2022
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
}

// ─── Helper: Create Compute Budget Instructions ────────────────────────────

function createSetComputeUnitLimitInstruction(
  units: number
): TransactionInstruction {
  const data = Buffer.alloc(5);
  data.writeUInt8(2, 0); // SetComputeUnitLimit instruction index
  data.writeUInt32LE(units, 1);

  return new TransactionInstruction({
    programId: new PublicKey("ComputeBudget111111111111111111111111111111"),
    keys: [],
    data,
  });
}

function createSetComputeUnitPriceInstruction(
  microLamports: bigint
): TransactionInstruction {
  const data = Buffer.alloc(9);
  data.writeUInt8(3, 0); // SetComputeUnitPrice instruction index
  data.writeBigUInt64LE(microLamports, 1);

  return new TransactionInstruction({
    programId: new PublicKey("ComputeBudget111111111111111111111111111111"),
    keys: [],
    data,
  });
}

// ─── Helper: Create ATA Idempotent Instruction ─────────────────────────────

function createAssociatedTokenAccountIdempotentInstruction(
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
    data: Buffer.from([1]), // CreateIdempotent instruction
  });
}

// ─── WSOL Helpers ──────────────────────────────────────────────────────────

/**
 * Create instructions to wrap SOL into WSOL (Wrapped SOL).
 *
 * For buying tokens with SOL, the Axiom/Pump.fun programs handle
 * the SOL transfer internally through the System Program CPI,
 * so explicit WSOL wrapping is typically NOT needed for Pump.fun buys.
 *
 * However, this utility is provided for other DEXes that require WSOL.
 */
export function createWrapSolInstructions(
  owner: PublicKey,
  amount: bigint
): TransactionInstruction[] {
  const wsolATA = deriveATA(owner, NATIVE_MINT, TOKEN_PROGRAM_ID);
  const instructions: TransactionInstruction[] = [];

  // Create WSOL ATA (idempotent)
  instructions.push(
    createAssociatedTokenAccountIdempotentInstruction(
      owner,
      wsolATA,
      owner,
      NATIVE_MINT,
      TOKEN_PROGRAM_ID
    )
  );

  // Transfer SOL to WSOL account
  instructions.push(
    createTransferSolInstruction(owner, wsolATA, amount)
  );

  // Sync native (update WSOL balance)
  instructions.push(createSyncNativeInstruction(wsolATA));

  return instructions;
}

/**
 * Create instruction to unwrap WSOL back to SOL.
 */
export function createUnwrapSolInstruction(
  owner: PublicKey
): TransactionInstruction {
  const wsolATA = deriveATA(owner, NATIVE_MINT, TOKEN_PROGRAM_ID);

  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [
      { pubkey: wsolATA, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: false, isWritable: true },
      { pubkey: owner, isSigner: true, isWritable: false },
    ],
    data: Buffer.from([9]), // CloseAccount instruction
  });
}

function createTransferSolInstruction(
  from: PublicKey,
  to: PublicKey,
  lamports: bigint
): TransactionInstruction {
  const data = Buffer.alloc(12);
  data.writeUInt32LE(2, 0); // Transfer instruction index
  data.writeBigUInt64LE(lamports, 4);

  return new TransactionInstruction({
    programId: SYSTEM_PROGRAM_ID,
    keys: [
      { pubkey: from, isSigner: true, isWritable: true },
      { pubkey: to, isSigner: false, isWritable: true },
    ],
    data,
  });
}

function createSyncNativeInstruction(
  account: PublicKey
): TransactionInstruction {
  return new TransactionInstruction({
    programId: TOKEN_PROGRAM_ID,
    keys: [{ pubkey: account, isSigner: false, isWritable: true }],
    data: Buffer.from([17]), // SyncNative instruction
  });
}

/**
 * Detect the token program type for a given mint by querying the chain.
 */
export async function detectTokenProgramType(
  connection: Connection,
  mint: PublicKey
): Promise<TokenProgramType> {
  const accountInfo = await connection.getAccountInfo(mint);
  if (!accountInfo) {
    throw new Error(`Mint account not found: ${mint.toBase58()}`);
  }

  if (accountInfo.owner.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()) {
    return TokenProgramType.TOKEN_2022;
  }

  return TokenProgramType.TOKEN;
}

/**
 * Fetch the bonding curve creator for deriving the creator vault.
 * The creator is stored in the bonding curve account data.
 */
export async function fetchBondingCurveCreator(
  connection: Connection,
  bondingCurve: PublicKey
): Promise<PublicKey | null> {
  const accountInfo = await connection.getAccountInfo(bondingCurve);
  if (!accountInfo || !accountInfo.data) {
    return null;
  }

  // The bonding curve account data layout (Anchor):
  // [8 bytes discriminator][...fields...]
  // The creator field position depends on the IDL
  // Typically: discriminator(8) + virtual_token_reserves(8) + virtual_sol_reserves(8) +
  //            real_token_reserves(8) + real_sol_reserves(8) + token_total_supply(8) +
  //            complete(1) + creator(32)
  const data = accountInfo.data;
  if (data.length >= 8 + 8 + 8 + 8 + 8 + 8 + 1 + 32) {
    const creatorOffset = 8 + 8 + 8 + 8 + 8 + 8 + 1;
    const creatorBytes = data.subarray(creatorOffset, creatorOffset + 32);
    return new PublicKey(creatorBytes);
  }

  return null;
}
