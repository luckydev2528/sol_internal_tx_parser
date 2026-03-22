import { Connection } from "@solana/web3.js";

const DEFAULT_RPC_URL = "https://api.mainnet-beta.solana.com";

/**
 * Create a Solana RPC connection.
 */
export function createConnection(rpcUrl?: string): Connection {
  return new Connection(rpcUrl || DEFAULT_RPC_URL, {
    commitment: "confirmed",
  });
}
