import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  PUMP_FUN_PROGRAM_ID,
  PUMP_FUN_BUY_DISCRIMINATOR,
  PUMP_FUN_SELL_DISCRIMINATOR,
  PUMP_FUN_GLOBAL,
  PUMP_FUN_FEE_RECIPIENT,
  SYSTEM_PROGRAM_ID,
  RENT_PROGRAM_ID,
} from "./constants";
import {
  RoutingInfo,
  PumpFunBuyAccounts,
  RebuiltInstruction,
  SwapDirection,
  TokenProgramType,
} from "./types";
import {
  deriveATA,
  getTokenProgramId,
  createATAInstruction,
  createWSOLInstructions,
  createCloseWSOLInstruction,
  ataExists,
  solToLamports,
  detectTokenProgram,
} from "./utils";

/**
 * InstructionRebuilder - Reconstructs swap instructions from parsed routing info.
 * Handles:
 * - ATA creation (if needed)
 * - WSOL wrapping/unwrapping
 * - Token vs Token2022 program detection
 * - Pool orientation and vault swap accounts
 * - Fee accounts
 */
export class InstructionRebuilder {
  private connection: Connection;

  constructor(rpcEndpoint: string) {
    this.connection = new Connection(rpcEndpoint, "confirmed");
  }

  /**
   * Rebuild a Pump.fun buy instruction from routing info.
   * Returns the complete instruction set ready for simulation/execution.
   */
  async rebuildPumpFunBuy(
    routingInfo: RoutingInfo,
    userWallet: PublicKey,
    solAmount: number,
    slippageBps: number = 1000
  ): Promise<RebuiltInstruction> {
    const { swap } = routingInfo;
    const mint = new PublicKey(swap.tokenMint);

    // Detect token program type
    let tokenProgramType: TokenProgramType;
    try {
      tokenProgramType = await detectTokenProgram(this.connection, mint);
    } catch {
      tokenProgramType = swap.tokenProgramType;
    }

    const tokenProgramId = getTokenProgramId(tokenProgramType);

    // Derive user's ATA for the token
    const userTokenATA = deriveATA(userWallet, mint, tokenProgramType);

    // Build instruction list
    const instructions: TransactionInstruction[] = [];

    // 1. Compute budget
    instructions.push(
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 100_000 })
    );

    // 2. Create user token ATA if needed
    const userATAExists = await ataExists(this.connection, userTokenATA);
    if (!userATAExists) {
      instructions.push(
        createATAInstruction(userWallet, userWallet, mint, tokenProgramType)
      );
    }

    // 3. WSOL handling for buy (SOL → Token)
    if (swap.direction === SwapDirection.SOL_TO_TOKEN) {
      const lamports = solToLamports(solAmount);
      const { instructions: wsolIxs } = createWSOLInstructions(
        userWallet,
        lamports
      );
      instructions.push(...wsolIxs);
    }

    // 4. Build the Pump.fun buy instruction
    const pumpFunAccounts = routingInfo.pumpFunAccounts
      ? routingInfo.pumpFunAccounts
      : await this.derivePumpFunAccounts(
          mint,
          userWallet,
          userTokenATA,
          tokenProgramType
        );

    const buyData = this.encodePumpFunBuy(
      swap.direction === SwapDirection.SOL_TO_TOKEN,
      solAmount,
      slippageBps
    );

    const pumpFunIx = new TransactionInstruction({
      programId: PUMP_FUN_PROGRAM_ID,
      keys: this.buildPumpFunAccountMetas(
        pumpFunAccounts,
        userWallet,
        userTokenATA,
        tokenProgramId
      ),
      data: buyData,
    });

    instructions.push(pumpFunIx);

    // 5. Close WSOL account after swap (cleanup)
    if (swap.direction === SwapDirection.SOL_TO_TOKEN) {
      instructions.push(createCloseWSOLInstruction(userWallet));
    }

    // Build the versioned transaction
    const { blockhash } = await this.connection.getLatestBlockhash();
    const messageV0 = new TransactionMessage({
      payerKey: userWallet,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    const transaction = new VersionedTransaction(messageV0);

    return {
      serializedTransaction: Buffer.from(
        transaction.serialize()
      ).toString("base64"),
      accounts: pumpFunIx.keys.map((k) => ({
        pubkey: k.pubkey.toBase58(),
        isSigner: k.isSigner,
        isWritable: k.isWritable,
      })),
      data: buyData.toString("hex"),
      programId: PUMP_FUN_PROGRAM_ID.toBase58(),
    };
  }

  /**
   * Derive Pump.fun accounts when not available from the original transaction.
   * Uses on-chain PDAs to find bonding curve and associated accounts.
   */
  private async derivePumpFunAccounts(
    mint: PublicKey,
    user: PublicKey,
    userTokenATA: PublicKey,
    tokenProgramType: TokenProgramType
  ): Promise<PumpFunBuyAccounts> {
    // Derive bonding curve PDA
    const [bondingCurve] = PublicKey.findProgramAddressSync(
      [Buffer.from("bonding-curve"), mint.toBuffer()],
      PUMP_FUN_PROGRAM_ID
    );

    // Derive associated bonding curve (ATA of bonding curve for the mint)
    const associatedBondingCurve = deriveATA(
      bondingCurve,
      mint,
      tokenProgramType
    );

    // Derive event authority PDA
    const [eventAuthority] = PublicKey.findProgramAddressSync(
      [Buffer.from("__event_authority")],
      PUMP_FUN_PROGRAM_ID
    );

    // Creator vault - derive from mint
    const [creatorVault] = PublicKey.findProgramAddressSync(
      [Buffer.from("creator-vault"), mint.toBuffer()],
      PUMP_FUN_PROGRAM_ID
    );

    return {
      global: PUMP_FUN_GLOBAL,
      feeRecipient: PUMP_FUN_FEE_RECIPIENT,
      mint,
      bondingCurve,
      associatedBondingCurve,
      associatedUser: userTokenATA,
      user,
      systemProgram: SYSTEM_PROGRAM_ID,
      tokenProgram: getTokenProgramId(tokenProgramType),
      creatorVault,
      rent: RENT_PROGRAM_ID,
      eventAuthority,
      program: PUMP_FUN_PROGRAM_ID,
    };
  }

  /**
   * Encode Pump.fun buy/sell instruction data.
   * Layout: [8B discriminator][8B tokenAmount][8B maxSolCost]
   */
  private encodePumpFunBuy(
    isBuy: boolean,
    solAmount: number,
    slippageBps: number
  ): Buffer {
    const data = Buffer.alloc(24);

    // Discriminator
    const disc = isBuy
      ? PUMP_FUN_BUY_DISCRIMINATOR
      : PUMP_FUN_SELL_DISCRIMINATOR;
    disc.copy(data, 0);

    // Token amount (u64) - for buy, this is typically set to max (slippage handled via maxSolCost)
    // Use a large number to represent "buy as much as possible"
    const tokenAmount = isBuy ? BigInt("18446744073709551615") : BigInt(0);
    data.writeBigUInt64LE(tokenAmount, 8);

    // Max SOL cost with slippage (u64, in lamports)
    const maxSolLamports = solToLamports(
      solAmount * (1 + slippageBps / 10000)
    );
    data.writeBigUInt64LE(maxSolLamports, 16);

    return data;
  }

  /**
   * Build the account metas for a Pump.fun instruction.
   */
  private buildPumpFunAccountMetas(
    accounts: PumpFunBuyAccounts,
    user: PublicKey,
    userTokenATA: PublicKey,
    tokenProgramId: PublicKey
  ): {
    pubkey: PublicKey;
    isSigner: boolean;
    isWritable: boolean;
  }[] {
    return [
      { pubkey: accounts.global, isSigner: false, isWritable: false },
      { pubkey: accounts.feeRecipient, isSigner: false, isWritable: true },
      { pubkey: accounts.mint, isSigner: false, isWritable: false },
      { pubkey: accounts.bondingCurve, isSigner: false, isWritable: true },
      {
        pubkey: accounts.associatedBondingCurve,
        isSigner: false,
        isWritable: true,
      },
      { pubkey: userTokenATA, isSigner: false, isWritable: true },
      { pubkey: user, isSigner: true, isWritable: true },
      {
        pubkey: accounts.systemProgram,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: tokenProgramId, isSigner: false, isWritable: false },
      { pubkey: accounts.creatorVault, isSigner: false, isWritable: true },
      { pubkey: accounts.rent, isSigner: false, isWritable: false },
      {
        pubkey: accounts.eventAuthority,
        isSigner: false,
        isWritable: false,
      },
      { pubkey: accounts.program, isSigner: false, isWritable: false },
    ];
  }
}
