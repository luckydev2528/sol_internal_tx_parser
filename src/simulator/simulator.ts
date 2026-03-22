import {
  Connection,
  PublicKey,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
  AddressLookupTableAccount,
} from "@solana/web3.js";
import { SimulationResult } from "../types";

/**
 * Simulate a transaction from a set of instructions.
 *
 * @param connection - Solana RPC connection
 * @param instructions - The instructions to simulate
 * @param payer - The fee payer / signer
 * @param addressLookupTables - Optional ALTs for V0 transactions
 * @returns SimulationResult with success/failure info and logs
 */
export async function simulateTransaction(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: PublicKey,
  addressLookupTables?: AddressLookupTableAccount[]
): Promise<SimulationResult> {
  // Get a recent blockhash for the simulation
  const { blockhash } = await connection.getLatestBlockhash("confirmed");

  // Build a versioned transaction message
  const messageV0 = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: blockhash,
    instructions,
  }).compileToV0Message(addressLookupTables);

  const transaction = new VersionedTransaction(messageV0);

  // Simulate the transaction
  const simulation = await connection.simulateTransaction(transaction, {
    sigVerify: false, // Skip signature verification for simulation
    commitment: "confirmed",
  });

  const result = simulation.value;

  return {
    success: result.err === null,
    logs: result.logs || [],
    unitsConsumed: result.unitsConsumed || 0,
    error: result.err ? JSON.stringify(result.err) : undefined,
    returnData: result.returnData
      ? {
          programId: result.returnData.programId,
          data: result.returnData.data[0],
        }
      : undefined,
  };
}

/**
 * Simulate a swap and return a human-readable summary.
 */
export async function simulateAndSummarize(
  connection: Connection,
  instructions: TransactionInstruction[],
  payer: PublicKey,
  addressLookupTables?: AddressLookupTableAccount[]
): Promise<string> {
  const result = await simulateTransaction(
    connection,
    instructions,
    payer,
    addressLookupTables
  );

  const lines: string[] = [];
  lines.push(`=== Simulation Result ===`);
  lines.push(`Success: ${result.success}`);
  lines.push(`Compute Units: ${result.unitsConsumed}`);

  if (result.error) {
    lines.push(`Error: ${result.error}`);
  }

  if (result.logs.length > 0) {
    lines.push(`\nLogs:`);
    for (const log of result.logs) {
      lines.push(`  ${log}`);
    }
  }

  return lines.join("\n");
}
