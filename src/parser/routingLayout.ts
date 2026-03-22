import {
  AxiomAccountsMap,
  DexType,
  PoolOrientation,
  RoutingLayout,
  SwapDirection,
  TokenProgramType,
} from "../types";
import { TOKEN_2022_PROGRAM_ID } from "../constants";

/**
 * Analyze the routing layout from the parsed Axiom Trade instruction.
 *
 * For Pump.fun:
 * - The pool uses a bonding curve model
 * - SOL is always the quote token (Token/SOL orientation)
 * - The bonding curve holds the token supply
 * - Price moves along the bonding curve as supply changes
 */
export function analyzeRoutingLayout(
  dex: DexType,
  direction: SwapDirection,
  accounts: AxiomAccountsMap
): RoutingLayout {
  const tokenProgramType =
    accounts.tokenProgram.toBase58() === TOKEN_2022_PROGRAM_ID.toBase58()
      ? TokenProgramType.TOKEN_2022
      : TokenProgramType.TOKEN;

  // Pump.fun always uses Token/SOL orientation (SOL is the quote)
  const poolOrientation =
    dex === DexType.PUMPFUN
      ? PoolOrientation.SOL_QUOTE
      : PoolOrientation.SOL_BASE;

  return {
    dex,
    direction,
    tokenMint: accounts.mint,
    tokenProgramType,
    poolOrientation,
    accounts,
  };
}

/**
 * Describe the routing layout in human-readable format.
 */
export function describeRoutingLayout(layout: RoutingLayout): string {
  const lines: string[] = [];

  lines.push(`DEX: ${layout.dex}`);
  lines.push(`Direction: ${layout.direction}`);
  lines.push(`Token Mint: ${layout.tokenMint.toBase58()}`);
  lines.push(`Token Program: ${layout.tokenProgramType}`);
  lines.push(`Pool Orientation: ${layout.poolOrientation}`);

  if (layout.direction === SwapDirection.SOL_TO_TOKEN) {
    lines.push(`Route: SOL → ${layout.tokenMint.toBase58().slice(0, 8)}...`);
  } else {
    lines.push(`Route: ${layout.tokenMint.toBase58().slice(0, 8)}... → SOL`);
  }

  lines.push(`\nAccounts:`);
  lines.push(`  Signer:           ${layout.accounts.signer.toBase58()}`);
  lines.push(`  Mint:             ${layout.accounts.mint.toBase58()}`);
  lines.push(`  Bonding Curve:    ${layout.accounts.bondingCurve.toBase58()}`);
  lines.push(`  Assoc. BC:        ${layout.accounts.associatedBondingCurve.toBase58()}`);
  lines.push(`  Assoc. User:      ${layout.accounts.associatedUser.toBase58()}`);
  lines.push(`  Global:           ${layout.accounts.global.toBase58()}`);
  lines.push(`  Fee Recipient:    ${layout.accounts.feeRecipient.toBase58()}`);
  lines.push(`  Event Authority:  ${layout.accounts.eventAuthority.toBase58()}`);
  lines.push(`  Creator Vault:    ${layout.accounts.creatorVault.toBase58()}`);
  lines.push(`  Token Program:    ${layout.accounts.tokenProgram.toBase58()}`);
  lines.push(`  System Program:   ${layout.accounts.systemProgram.toBase58()}`);
  lines.push(`  DEX Program:      ${layout.accounts.dexProgram.toBase58()}`);

  if (layout.accounts.globalVolumeAccumulator) {
    lines.push(`  Global Vol. Acc:  ${layout.accounts.globalVolumeAccumulator.toBase58()}`);
  }
  if (layout.accounts.userVolumeAccumulator) {
    lines.push(`  User Vol. Acc:    ${layout.accounts.userVolumeAccumulator.toBase58()}`);
  }
  if (layout.accounts.feeConfig) {
    lines.push(`  Fee Config:       ${layout.accounts.feeConfig.toBase58()}`);
  }
  if (layout.accounts.feeProgram) {
    lines.push(`  Fee Program:      ${layout.accounts.feeProgram.toBase58()}`);
  }

  return lines.join("\n");
}
