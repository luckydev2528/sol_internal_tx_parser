import {
  Connection,
  ParsedTransactionWithMeta,
  PartiallyDecodedInstruction,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  AXIOM_TRADE_PROGRAM_ID,
  NATIVE_MINT,
  PUMPFUN_PROGRAM_ID,
} from "../constants";
import {
  AxiomAccountsMap,
  AxiomInstructionType,
  DexType,
  ParsedAxiomInstruction,
  ParsedSwapResult,
  SwapDirection,
  TokenProgramType,
} from "../types";
import {
  decodeAxiomDiscriminator,
  decodeSwapArgs,
} from "../utils/decoder";

/**
 * Fetch and parse an Axiom Trade transaction from Solana.
 */
export async function parseAxiomTransaction(
  connection: Connection,
  signature: string
): Promise<ParsedSwapResult> {
  const tx = await connection.getParsedTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  if (!tx) {
    throw new Error(`Transaction not found: ${signature}`);
  }

  if (tx.meta?.err) {
    throw new Error(`Transaction failed: ${JSON.stringify(tx.meta.err)}`);
  }

  const parsed = parseAxiomFromParsedTransaction(tx);
  const balances = extractTokenBalances(tx, parsed.accounts.signer);

  return {
    signature,
    signer: parsed.accounts.signer.toBase58(),
    direction: parsed.direction,
    dex: parsed.dex,
    tokenMint: parsed.mint.toBase58(),
    tokenProgramType: resolveTokenProgramType(parsed.accounts.tokenProgram),
    solAmount: balances.solChange,
    tokenAmount: balances.tokenChange,
    instructionType: parsed.type,
  };
}

/**
 * Parse the Axiom Trade instruction from a pre-fetched parsed transaction.
 */
export function parseAxiomFromParsedTransaction(
  tx: ParsedTransactionWithMeta
): ParsedAxiomInstruction {
  const instructions = tx.transaction.message.instructions;

  // Find the Axiom Trade instruction
  const axiomIx = instructions.find(
    (ix) => ix.programId.toBase58() === AXIOM_TRADE_PROGRAM_ID.toBase58()
  ) as PartiallyDecodedInstruction | undefined;

  if (!axiomIx) {
    throw new Error("No Axiom Trade instruction found in transaction");
  }

  return decodeAxiomInstruction(axiomIx, tx);
}

/**
 * Decode a raw Axiom Trade instruction into a structured result.
 */
export function decodeAxiomInstruction(
  ix: PartiallyDecodedInstruction,
  tx: ParsedTransactionWithMeta
): ParsedAxiomInstruction {
  const rawData = Buffer.from(bs58.decode(ix.data));
  const instructionType = decodeAxiomDiscriminator(rawData);

  if (instructionType === AxiomInstructionType.UNKNOWN) {
    throw new Error(
      `Unknown Axiom instruction discriminator: ${rawData
        .subarray(0, 8)
        .toString("hex")}`
    );
  }

  // Determine direction from the instruction type
  const direction = getDirectionFromInstructionType(instructionType);

  // Determine the DEX by examining inner instructions
  const dex = identifyDexFromInnerInstructions(tx);

  // Map accounts based on instruction type and DEX
  const accounts = mapPumpfunAccounts(ix.accounts, instructionType);

  // Decode swap arguments
  const { amountIn, minAmountOut } = decodeSwapArgs(rawData);

  return {
    type: instructionType,
    direction,
    dex,
    mint: accounts.mint,
    amountIn,
    minAmountOut,
    accounts,
    rawData,
  };
}

/**
 * Determine swap direction from instruction type.
 */
function getDirectionFromInstructionType(
  type: AxiomInstructionType
): SwapDirection {
  switch (type) {
    case AxiomInstructionType.BUY_EXACT_IN:
    case AxiomInstructionType.BUY:
    case AxiomInstructionType.BUY_MAX_OUT:
      return SwapDirection.SOL_TO_TOKEN;
    case AxiomInstructionType.SELL_EXACT_IN:
    case AxiomInstructionType.SELL:
      return SwapDirection.TOKEN_TO_SOL;
    default:
      throw new Error(`Cannot determine direction for instruction type: ${type}`);
  }
}

/**
 * Identify the DEX by examining inner instructions / CPI calls.
 */
function identifyDexFromInnerInstructions(
  tx: ParsedTransactionWithMeta
): DexType {
  const innerInstructions = tx.meta?.innerInstructions || [];

  for (const innerSet of innerInstructions) {
    for (const inner of innerSet.instructions) {
      if (inner.programId.toBase58() === PUMPFUN_PROGRAM_ID.toBase58()) {
        return DexType.PUMPFUN;
      }
    }
  }

  // Also check the log messages for hints
  const logs = tx.meta?.logMessages || [];
  for (const log of logs) {
    if (log.includes(PUMPFUN_PROGRAM_ID.toBase58())) {
      return DexType.PUMPFUN;
    }
  }

  return DexType.UNKNOWN;
}

/**
 * Map accounts for Pump.fun buy/sell through Axiom.
 *
 * The Axiom program wraps the Pump.fun instruction. The account layout
 * for `buy_exact_in` through Pump.fun is:
 *
 * [0]  global                (Pump.fun global PDA)
 * [1]  feeRecipient          (Pump.fun fee recipient, writable)
 * [2]  mint                  (Token mint)
 * [3]  bondingCurve          (Pump.fun bonding curve PDA, writable)
 * [4]  associatedBondingCurve (Bonding curve's token account, writable)
 * [5]  associatedUser        (User's token account / ATA, writable)
 * [6]  signer/user           (User wallet, signer, writable)
 * [7]  systemProgram         (System Program)
 * [8]  tokenProgram          (SPL Token Program)
 * [9]  creatorVault          (Creator vault PDA, writable)
 * [10] eventAuthority        (Event authority PDA)
 * [11] dexProgram            (Pump.fun program)
 * [12] globalVolumeAccumulator (optional)
 * [13] userVolumeAccumulator   (optional)
 * [14] feeConfig               (optional)
 * [15] feeProgram              (optional)
 */
function mapPumpfunAccounts(
  accounts: PublicKey[],
  _instructionType: AxiomInstructionType
): AxiomAccountsMap {
  if (accounts.length < 12) {
    throw new Error(
      `Expected at least 12 accounts for Pump.fun instruction, got ${accounts.length}`
    );
  }

  const mapped: AxiomAccountsMap = {
    global: accounts[0]!,
    feeRecipient: accounts[1]!,
    mint: accounts[2]!,
    bondingCurve: accounts[3]!,
    associatedBondingCurve: accounts[4]!,
    associatedUser: accounts[5]!,
    signer: accounts[6]!,
    systemProgram: accounts[7]!,
    tokenProgram: accounts[8]!,
    creatorVault: accounts[9]!,
    eventAuthority: accounts[10]!,
    dexProgram: accounts[11]!,
  };

  // Optional accounts
  if (accounts.length > 12) {
    mapped.globalVolumeAccumulator = accounts[12];
  }
  if (accounts.length > 13) {
    mapped.userVolumeAccumulator = accounts[13];
  }
  if (accounts.length > 14) {
    mapped.feeConfig = accounts[14];
  }
  if (accounts.length > 15) {
    mapped.feeProgram = accounts[15];
  }

  return mapped;
}

/**
 * Resolve token program type from token program ID.
 */
function resolveTokenProgramType(tokenProgram: PublicKey): TokenProgramType {
  if (
    tokenProgram.toBase58() === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
  ) {
    return TokenProgramType.TOKEN_2022;
  }
  return TokenProgramType.TOKEN;
}

/**
 * Extract SOL and token balance changes from the transaction for a given owner.
 */
function extractTokenBalances(
  tx: ParsedTransactionWithMeta,
  owner: PublicKey
): { solChange: number; tokenChange: number } {
  let solChange = 0;
  let tokenChange = 0;
  const ownerStr = owner.toBase58();

  // Calculate SOL change from pre/post balances
  const accountKeys = tx.transaction.message.accountKeys;
  for (let i = 0; i < accountKeys.length; i++) {
    const key = accountKeys[i]!;
    const keyObj = key as { pubkey?: PublicKey };
    const pubkey = keyObj.pubkey ? keyObj.pubkey.toBase58() : (key as unknown as PublicKey).toBase58();
    if (pubkey === ownerStr) {
      const preBal = tx.meta?.preBalances?.[i] || 0;
      const postBal = tx.meta?.postBalances?.[i] || 0;
      solChange = (postBal - preBal) / 1e9; // Convert lamports to SOL
      break;
    }
  }

  // Calculate token change from pre/post token balances
  const preTokenBals = tx.meta?.preTokenBalances || [];
  const postTokenBals = tx.meta?.postTokenBalances || [];

  // Find the user's token accounts that changed
  for (const postBal of postTokenBals) {
    if (
      postBal.owner === ownerStr &&
      postBal.mint !== NATIVE_MINT.toBase58()
    ) {
      const preBal = preTokenBals.find(
        (p) => p.accountIndex === postBal.accountIndex
      );
      const preAmount = preBal
        ? parseFloat(preBal.uiTokenAmount.uiAmountString || "0")
        : 0;
      const postAmount = parseFloat(
        postBal.uiTokenAmount.uiAmountString || "0"
      );
      tokenChange = postAmount - preAmount;
      break;
    }
  }

  return { solChange, tokenChange };
}
