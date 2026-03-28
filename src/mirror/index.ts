// Mirror module — outer-transaction-only swap mirroring
export {
  mirrorAxiomSwap,
  versionedTxToRawOuter,
  type MirrorConfig,
} from "./mirrorAxiomSwap";

export {
  decodeAxiomOuterInstructions,
  findAxiomSwapInstruction,
  isAxiomTransaction,
  type DecodedAxiomOuter,
} from "./outerTxDecoder";

export type {
  RawOuterTransaction,
  RawOuterInstruction,
  AddressTableLookup,
  MirrorResult,
} from "./types";
