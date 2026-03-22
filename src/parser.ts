import {
  Connection,
  ParsedTransactionWithMeta,
  ParsedInstruction,
  PartiallyDecodedInstruction,
  PublicKey,
} from "@solana/web3.js";
import bs58 from "bs58";
import {
  AXIOM_PROGRAM_ID,
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_BUY_DISCRIMINATOR,
  PUMP_FUN_SELL_DISCRIMINATOR,
  ANCHOR_EVENT_TAG,
  TRADE_EVENT_DISCRIMINATOR,
  DEX_PROGRAMS,
  NATIVE_SOL_MINT,
  PUMP_FUN_GLOBAL,
} from "./constants";
import {
  ParsedSwap,
  SwapDirection,
  DexPlatform,
  TokenProgramType,
  PumpFunBuyAccounts,
  PumpFunTradeEvent,
  RoutingInfo,
} from "./types";
import { lamportsToSOL, rawToUIAmount, isNativeSOL } from "./utils";

/**
 * AxiomTransactionParser - Parses Axiom Trade transactions to extract
 * routing information, token mints, swap direction, and account mappings.
 */
export class AxiomTransactionParser {
  private connection: Connection;

  constructor(rpcEndpoint: string) {
    this.connection = new Connection(rpcEndpoint, "confirmed");
  }

  /**
   * Parse a transaction by its signature.
   * Returns full routing info including swap details, accounts, and trade events.
   */
  async parseTransaction(signature: string): Promise<RoutingInfo> {
    const tx = await this.connection.getParsedTransaction(signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });

    if (!tx) {
      throw new Error(`Transaction not found: ${signature}`);
    }

    if (tx.meta?.err) {
      throw new Error(
        `Transaction failed: ${JSON.stringify(tx.meta.err)}`
      );
    }

    return this.parseTransactionData(tx, signature);
  }

  /**
   * Parse an already-fetched transaction object.
   */
  parseTransactionData(
    tx: ParsedTransactionWithMeta,
    signature: string
  ): RoutingInfo {
    const accountKeys = tx.transaction.message.accountKeys.map((k) =>
      k.pubkey.toBase58()
    );

    // Step 1: Identify signer
    const signer = this.extractSigner(tx);

    // Step 2: Detect Axiom Trade instruction
    const axiomIxIndex = this.findAxiomInstructionIndex(tx);

    // Step 3: Detect underlying DEX platform from inner instructions or account keys
    const platform = this.detectPlatform(tx, accountKeys, axiomIxIndex);

    // Step 4: Try to extract swap data from Pump.fun CPI (inner instructions)
    const pumpFunResult = this.tryParsePumpFunCPI(
      tx,
      accountKeys,
      signer,
      axiomIxIndex
    );

    // Step 5: If CPI parsing failed, use balance diff method
    if (pumpFunResult) {
      return {
        swap: {
          signature,
          signer,
          routerProgram: AXIOM_PROGRAM_ID.toBase58(),
          platform: pumpFunResult.platform,
          direction: pumpFunResult.isBuy
            ? SwapDirection.SOL_TO_TOKEN
            : SwapDirection.TOKEN_TO_SOL,
          tokenMint: pumpFunResult.mint,
          solAmount: pumpFunResult.solAmount,
          tokenAmount: pumpFunResult.tokenAmount,
          tokenDecimals: pumpFunResult.tokenDecimals,
          tokenProgramType: pumpFunResult.tokenProgramType,
        },
        pumpFunAccounts: pumpFunResult.accounts,
        tradeEvent: pumpFunResult.tradeEvent,
        innerInstructionIndices: pumpFunResult.innerIndices,
      };
    }

    // Fallback: Use pre/post token balance diffs
    const balanceResult = this.parseFromBalances(tx, signer, platform);

    return {
      swap: {
        signature,
        signer,
        routerProgram: AXIOM_PROGRAM_ID.toBase58(),
        platform,
        ...balanceResult,
      },
      innerInstructionIndices: axiomIxIndex !== -1 ? [axiomIxIndex] : [],
    };
  }

  /**
   * Extract the signer/fee payer from the transaction.
   */
  private extractSigner(tx: ParsedTransactionWithMeta): string {
    const keys = tx.transaction.message.accountKeys;
    for (const key of keys) {
      if (key.signer) {
        return key.pubkey.toBase58();
      }
    }
    return keys[0].pubkey.toBase58();
  }

  /**
   * Find the instruction index where Axiom Trade program is invoked.
   */
  private findAxiomInstructionIndex(
    tx: ParsedTransactionWithMeta
  ): number {
    const instructions = tx.transaction.message.instructions;
    for (let i = 0; i < instructions.length; i++) {
      const ix = instructions[i];
      if (this.isAxiomInstruction(ix)) {
        return i;
      }
    }
    return -1;
  }

  /**
   * Check if an instruction belongs to the Axiom Trade program.
   */
  private isAxiomInstruction(
    ix: ParsedInstruction | PartiallyDecodedInstruction
  ): boolean {
    if ("programId" in ix) {
      return ix.programId.toBase58() === AXIOM_PROGRAM_ID.toBase58();
    }
    return false;
  }

  /**
   * Detect the underlying DEX platform from account keys and inner instructions.
   */
  private detectPlatform(
    tx: ParsedTransactionWithMeta,
    accountKeys: string[],
    axiomIxIndex: number
  ): DexPlatform {
    // Check inner instructions for CPI to known DEX programs
    const innerIxs = tx.meta?.innerInstructions || [];
    for (const group of innerIxs) {
      if (axiomIxIndex !== -1 && group.index !== axiomIxIndex) continue;
      for (const ix of group.instructions) {
        if ("programId" in ix) {
          const progId = ix.programId.toBase58();
          if (progId in DEX_PROGRAMS) {
            return DEX_PROGRAMS[progId] as DexPlatform;
          }
        }
      }
    }

    // Fallback: check all account keys
    for (const key of accountKeys) {
      if (key in DEX_PROGRAMS) {
        return DEX_PROGRAMS[key] as DexPlatform;
      }
    }

    return "unknown";
  }

  /**
   * Try to parse Pump.fun buy/sell from CPI inner instructions.
   * This handles the case where Axiom Trade routes through Pump.fun.
   */
  private tryParsePumpFunCPI(
    tx: ParsedTransactionWithMeta,
    accountKeys: string[],
    signer: string,
    axiomIxIndex: number
  ): {
    platform: DexPlatform;
    mint: string;
    isBuy: boolean;
    solAmount: number;
    tokenAmount: number;
    tokenDecimals: number;
    tokenProgramType: TokenProgramType;
    accounts?: PumpFunBuyAccounts;
    tradeEvent?: PumpFunTradeEvent;
    innerIndices: number[];
  } | null {
    const innerIxs = tx.meta?.innerInstructions || [];
    const pumpFunProgramId = PUMP_FUN_PROGRAM_ID.toBase58();

    for (const group of innerIxs) {
      if (axiomIxIndex !== -1 && group.index !== axiomIxIndex) continue;

      // Step A: Look for Anchor CPI TradeEvent (most reliable)
      const tradeEvent = this.findTradeEvent(group.instructions);
      if (tradeEvent) {
        const accounts = this.findPumpFunAccounts(
          group.instructions,
          accountKeys
        );

        const tokenProgramType = accounts
          ? this.detectTokenProgramFromAccounts(accounts)
          : "token";

        return {
          platform: "pump_fun",
          mint: tradeEvent.mint.toBase58(),
          isBuy: tradeEvent.isBuy,
          solAmount: lamportsToSOL(tradeEvent.solAmount),
          tokenAmount: rawToUIAmount(tradeEvent.tokenAmount, 6),
          tokenDecimals: 6,
          tokenProgramType,
          accounts: accounts || undefined,
          tradeEvent,
          innerIndices: [group.index],
        };
      }

      // Step B: Look for Pump.fun direct instruction (discriminator matching)
      for (const ix of group.instructions) {
        if (!("programId" in ix)) continue;
        if (ix.programId.toBase58() !== pumpFunProgramId) continue;

        const decoded = ix as PartiallyDecodedInstruction;
        if (!decoded.data) continue;

        const data = Buffer.from(bs58.decode(decoded.data));
        const result = this.decodePumpFunInstruction(data);
        if (!result) continue;

        const accounts = this.extractPumpFunAccountsFromIx(
          decoded,
          accountKeys
        );

        const tokenProgramType = accounts
          ? this.detectTokenProgramFromAccounts(accounts)
          : "token";

        return {
          platform: "pump_fun",
          mint: accounts?.mint.toBase58() || "",
          isBuy: result.isBuy,
          solAmount: lamportsToSOL(result.maxSolCost),
          tokenAmount: rawToUIAmount(result.tokenAmount, 6),
          tokenDecimals: 6,
          tokenProgramType,
          accounts: accounts || undefined,
          innerIndices: [group.index],
        };
      }
    }

    return null;
  }

  /**
   * Find Anchor CPI TradeEvent in inner instructions.
   * Pump.fun emits TradeEvent via emit_cpi! which wraps in Anchor event envelope.
   */
  private findTradeEvent(
    instructions: (ParsedInstruction | PartiallyDecodedInstruction)[]
  ): PumpFunTradeEvent | null {
    for (const ix of instructions) {
      if (!("data" in ix) || !ix.data) continue;

      const data = Buffer.from(bs58.decode(ix.data));

      // Check for Anchor event tag + TradeEvent discriminator
      // Layout: [8B anchor:event tag][8B event discriminator][event data...]
      // Event data: mint(32) + solAmount(8) + tokenAmount(8) + isBuy(1) + user(32) + timestamp(8) + vsr(8) + vtr(8)
      if (data.length >= 121) {
        // 16 header + 105 data
        if (
          data.subarray(0, 8).equals(ANCHOR_EVENT_TAG) &&
          data.subarray(8, 16).equals(TRADE_EVENT_DISCRIMINATOR)
        ) {
          return this.decodeTradeEvent(data.subarray(16));
        }
      }
    }
    return null;
  }

  /**
   * Decode a Pump.fun TradeEvent from raw bytes.
   */
  private decodeTradeEvent(data: Buffer): PumpFunTradeEvent | null {
    if (data.length < 105) return null; // 32+8+8+1+32+8+8+8

    let offset = 0;

    const mint = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;

    const solAmount = data.readBigUInt64LE(offset);
    offset += 8;

    const tokenAmount = data.readBigUInt64LE(offset);
    offset += 8;

    const isBuy = data[offset] !== 0;
    offset += 1;

    const user = new PublicKey(data.subarray(offset, offset + 32));
    offset += 32;

    const timestamp = data.readBigInt64LE(offset);
    offset += 8;

    const virtualSolReserves = data.readBigUInt64LE(offset);
    offset += 8;

    const virtualTokenReserves = data.readBigUInt64LE(offset);

    return {
      mint,
      solAmount,
      tokenAmount,
      isBuy,
      user,
      timestamp,
      virtualSolReserves,
      virtualTokenReserves,
    };
  }

  /**
   * Decode Pump.fun buy/sell instruction from raw data.
   */
  private decodePumpFunInstruction(
    data: Buffer
  ): { isBuy: boolean; tokenAmount: bigint; maxSolCost: bigint } | null {
    if (data.length < 24) return null; // 8 discriminator + 8 amount + 8 maxSolCost

    const discriminator = data.subarray(0, 8);

    let isBuy: boolean;
    if (discriminator.equals(PUMP_FUN_BUY_DISCRIMINATOR)) {
      isBuy = true;
    } else if (discriminator.equals(PUMP_FUN_SELL_DISCRIMINATOR)) {
      isBuy = false;
    } else {
      return null;
    }

    const tokenAmount = data.readBigUInt64LE(8);
    const maxSolCost = data.readBigUInt64LE(16);

    return { isBuy, tokenAmount, maxSolCost };
  }

  /**
   * Find Pump.fun accounts from inner CPI instructions.
   * Looks for a CPI call to the Pump.fun program with the standard account layout.
   */
  private findPumpFunAccounts(
    instructions: (ParsedInstruction | PartiallyDecodedInstruction)[],
    accountKeys: string[]
  ): PumpFunBuyAccounts | null {
    const pumpFunProgramId = PUMP_FUN_PROGRAM_ID.toBase58();

    for (const ix of instructions) {
      if (!("programId" in ix)) continue;
      if (ix.programId.toBase58() !== pumpFunProgramId) continue;

      const decoded = ix as PartiallyDecodedInstruction;
      if (!decoded.accounts || decoded.accounts.length < 10) continue;

      // Validate: first account should be Pump.fun global
      const firstAccount = decoded.accounts[0].toBase58();
      if (firstAccount !== PUMP_FUN_GLOBAL.toBase58()) continue;

      return this.extractPumpFunAccountsFromIx(decoded, accountKeys);
    }

    return null;
  }

  /**
   * Extract PumpFunBuyAccounts from a partially decoded instruction.
   */
  private extractPumpFunAccountsFromIx(
    ix: PartiallyDecodedInstruction,
    _accountKeys: string[]
  ): PumpFunBuyAccounts | null {
    const accounts = ix.accounts;
    if (!accounts || accounts.length < 10) return null;

    return {
      global: accounts[0],
      feeRecipient: accounts[1],
      mint: accounts[2],
      bondingCurve: accounts[3],
      associatedBondingCurve: accounts[4],
      associatedUser: accounts[5],
      user: accounts[6],
      systemProgram: accounts[7],
      tokenProgram: accounts[8],
      creatorVault: accounts.length > 9 ? accounts[9] : accounts[8],
      rent:
        accounts.length > 10
          ? accounts[10]
          : new PublicKey("SysvarRent111111111111111111111111111111111"),
      eventAuthority:
        accounts.length > 11
          ? accounts[11]
          : new PublicKey("Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1"),
      program:
        accounts.length > 12 ? accounts[12] : PUMP_FUN_PROGRAM_ID,
    };
  }

  /**
   * Detect token program type from Pump.fun accounts.
   */
  private detectTokenProgramFromAccounts(
    accounts: PumpFunBuyAccounts
  ): TokenProgramType {
    const tokenProgramStr = accounts.tokenProgram.toBase58();
    if (
      tokenProgramStr === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
    ) {
      return "token2022";
    }
    return "token";
  }

  /**
   * Fallback: Parse swap from pre/post token balance diffs.
   * Works for any DEX without decoding instruction data.
   */
  private parseFromBalances(
    tx: ParsedTransactionWithMeta,
    signer: string,
    platform: DexPlatform
  ): {
    direction: SwapDirection;
    tokenMint: string;
    solAmount: number;
    tokenAmount: number;
    tokenDecimals: number;
    tokenProgramType: TokenProgramType;
  } {
    const meta = tx.meta!;

    // SOL balance change for signer (account index 0)
    const fee = meta.fee;
    const solChangeLamports =
      (meta.postBalances[0] - meta.preBalances[0]) + fee;

    // Token balance changes for signer
    const preTokens: Record<string, { amount: number; decimals: number }> =
      {};
    const postTokens: Record<string, { amount: number; decimals: number }> =
      {};

    for (const tb of meta.preTokenBalances || []) {
      if (tb.owner === signer) {
        preTokens[tb.mint] = {
          amount: tb.uiTokenAmount.uiAmount || 0,
          decimals: tb.uiTokenAmount.decimals,
        };
      }
    }

    for (const tb of meta.postTokenBalances || []) {
      if (tb.owner === signer) {
        postTokens[tb.mint] = {
          amount: tb.uiTokenAmount.uiAmount || 0,
          decimals: tb.uiTokenAmount.decimals,
        };
      }
    }

    // Find the non-SOL token with the largest absolute balance change
    const allMints = new Set([
      ...Object.keys(preTokens),
      ...Object.keys(postTokens),
    ]);

    let bestMint = "";
    let bestDiff = 0;
    let bestDecimals = 6;

    for (const mint of allMints) {
      if (isNativeSOL(mint)) continue;

      const pre = preTokens[mint]?.amount || 0;
      const post = postTokens[mint]?.amount || 0;
      const diff = Math.abs(post - pre);

      if (diff > bestDiff) {
        bestDiff = diff;
        bestMint = mint;
        bestDecimals = postTokens[mint]?.decimals || preTokens[mint]?.decimals || 6;
      }
    }

    if (!bestMint) {
      throw new Error("No token balance change detected for signer");
    }

    const tokenPre = preTokens[bestMint]?.amount || 0;
    const tokenPost = postTokens[bestMint]?.amount || 0;
    const tokenDiff = tokenPost - tokenPre;

    // Determine direction: SOL decreased + token increased = BUY
    const isBuy = solChangeLamports < 0 && tokenDiff > 0;

    // Detect token program type from post balance info
    let tokenProgramType: TokenProgramType = "token";
    for (const tb of meta.postTokenBalances || []) {
      if (tb.mint === bestMint && tb.owner === signer) {
        if (
          tb.programId === "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb"
        ) {
          tokenProgramType = "token2022";
        }
        break;
      }
    }

    return {
      direction: isBuy ? SwapDirection.SOL_TO_TOKEN : SwapDirection.TOKEN_TO_SOL,
      tokenMint: bestMint,
      solAmount: Math.abs(lamportsToSOL(solChangeLamports)),
      tokenAmount: Math.abs(tokenDiff),
      tokenDecimals: bestDecimals,
      tokenProgramType,
    };
  }
}
