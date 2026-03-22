import {
  Connection,
  VersionedTransaction,
  SimulatedTransactionResponse,
} from "@solana/web3.js";
import { SimulationResult } from "./types";

/**
 * TransactionSimulator - Simulates rebuilt transactions against the Solana RPC.
 * Validates that reconstructed instructions would pass on-chain execution.
 */
export class TransactionSimulator {
  private connection: Connection;

  constructor(rpcEndpoint: string) {
    this.connection = new Connection(rpcEndpoint, "confirmed");
  }

  /**
   * Simulate a serialized transaction (base64 encoded).
   */
  async simulate(serializedTxBase64: string): Promise<SimulationResult> {
    const txBytes = Buffer.from(serializedTxBase64, "base64");
    const transaction = VersionedTransaction.deserialize(txBytes);

    const result = await this.connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });

    return this.formatResult(result.value);
  }

  /**
   * Simulate a VersionedTransaction object directly.
   */
  async simulateTransaction(
    transaction: VersionedTransaction
  ): Promise<SimulationResult> {
    const result = await this.connection.simulateTransaction(transaction, {
      sigVerify: false,
      replaceRecentBlockhash: true,
    });

    return this.formatResult(result.value);
  }

  /**
   * Format simulation response into a clean result.
   */
  private formatResult(
    response: SimulatedTransactionResponse
  ): SimulationResult {
    const success = response.err === null;
    const logs = response.logs || [];
    const unitsConsumed = response.unitsConsumed || 0;

    let error: string | undefined;
    if (!success) {
      error =
        typeof response.err === "string"
          ? response.err
          : JSON.stringify(response.err);
    }

    return {
      success,
      logs,
      unitsConsumed,
      error,
    };
  }
}
