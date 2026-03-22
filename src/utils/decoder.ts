import { AXIOM_DISCRIMINATORS, PUMPFUN_DISCRIMINATORS } from "../constants";
import { AxiomInstructionType } from "../types";

/**
 * Read a little-endian u64 from a buffer at the given offset.
 */
export function readU64LE(buffer: Buffer, offset: number): bigint {
  return buffer.readBigUInt64LE(offset);
}

/**
 * Write a little-endian u64 to a buffer.
 */
export function writeU64LE(value: bigint): Buffer {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(value);
  return buf;
}

/**
 * Decode the Axiom instruction type from the first 8 bytes (discriminator).
 */
export function decodeAxiomDiscriminator(
  data: Buffer
): AxiomInstructionType {
  if (data.length < 8) {
    return AxiomInstructionType.UNKNOWN;
  }

  const disc = data.subarray(0, 8);

  for (const [name, expected] of Object.entries(AXIOM_DISCRIMINATORS)) {
    if (disc.equals(expected)) {
      return name as AxiomInstructionType;
    }
  }

  return AxiomInstructionType.UNKNOWN;
}

/**
 * Decode Pump.fun instruction discriminator.
 */
export function decodePumpfunDiscriminator(
  data: Buffer
): "buy" | "sell" | "unknown" {
  if (data.length < 8) {
    return "unknown";
  }

  const disc = data.subarray(0, 8);

  if (disc.equals(PUMPFUN_DISCRIMINATORS.buy)) {
    return "buy";
  }
  if (disc.equals(PUMPFUN_DISCRIMINATORS.sell)) {
    return "sell";
  }

  return "unknown";
}

/**
 * Decode the instruction arguments from a buy_exact_in or similar instruction.
 * Format: [8-byte discriminator][8-byte amount_in][8-byte min_amount_out]
 */
export function decodeSwapArgs(data: Buffer): {
  amountIn: bigint;
  minAmountOut: bigint;
} {
  if (data.length < 24) {
    throw new Error(
      `Instruction data too short: expected at least 24 bytes, got ${data.length}`
    );
  }
  return {
    amountIn: readU64LE(data, 8),
    minAmountOut: readU64LE(data, 16),
  };
}

/**
 * Encode swap instruction data with discriminator and args.
 */
export function encodeSwapData(
  discriminator: Buffer,
  amountIn: bigint,
  minAmountOut: bigint
): Buffer {
  return Buffer.concat([
    discriminator,
    writeU64LE(amountIn),
    writeU64LE(minAmountOut),
  ]);
}
