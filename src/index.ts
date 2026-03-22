// ─── Main Exports ──────────────────────────────────────────────────────────

// Parser
export {
  parseAxiomTransaction,
  parseAxiomFromParsedTransaction,
  decodeAxiomInstruction,
} from "./parser/axiomParser";

export {
  analyzeRoutingLayout,
  describeRoutingLayout,
} from "./parser/routingLayout";

// Builder
export {
  buildSwapInstructions,
  createWrapSolInstructions,
  createUnwrapSolInstruction,
  detectTokenProgramType,
  fetchBondingCurveCreator,
} from "./builder/instructionBuilder";

// Simulator
export {
  simulateTransaction,
  simulateAndSummarize,
} from "./simulator/simulator";

// Types
export {
  SwapDirection,
  DexType,
  TokenProgramType,
  AxiomInstructionType,
  PoolOrientation,
} from "./types";
export type {
  ParsedAxiomInstruction,
  AxiomAccountsMap,
  RoutingLayout,
  RebuildResult,
  SimulationResult,
  ParsedSwapResult,
} from "./types";

// Constants
export {
  AXIOM_TRADE_PROGRAM_ID,
  PUMPFUN_PROGRAM_ID,
  PUMPFUN_FEE_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  AXIOM_DISCRIMINATORS,
  PUMPFUN_DISCRIMINATORS,
} from "./constants";

// Utils
export {
  derivePumpfunGlobal,
  derivePumpfunBondingCurve,
  derivePumpfunAssociatedBondingCurve,
  derivePumpfunEventAuthority,
  derivePumpfunCreatorVault,
  derivePumpfunGlobalVolumeAccumulator,
  derivePumpfunUserVolumeAccumulator,
  derivePumpfunFeeConfig,
  deriveATA,
} from "./utils/pda";

export {
  decodeAxiomDiscriminator,
  decodePumpfunDiscriminator,
  decodeSwapArgs,
  encodeSwapData,
} from "./utils/decoder";

export { createConnection } from "./utils/connection";
