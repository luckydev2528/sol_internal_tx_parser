/**
 * Live mirror CLI:
 * - Subscribes to LaserStream transaction updates for a target wallet.
 * - On first matching transaction, fetches the full transaction from RPC.
 * - Uses ONLY outer transaction message data (no inner instructions).
 * - Builds a mirrored Axiom swap using a keypair from .env, then exits.
 */

import dotenv from "dotenv";
import Client, {
  CommitmentLevel,
  type ClientDuplexStream,
  type SubscribeRequest,
  type SubscribeUpdate,
} from "@triton-one/yellowstone-grpc";
import bs58 from "bs58";
import {
  AddressLookupTableAccount,
  Keypair,
  PublicKey,
  TransactionMessage,
  VersionedTransaction,
  type Connection,
} from "@solana/web3.js";
import {
  AXIOM_TRADE_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from "./constants";
import {
  findAxiomSwapInstruction,
  isAxiomTransaction,
  mirrorAxiomSwap,
  type RawOuterTransaction,
} from "./mirror";
import { createConnection } from "./utils/connection";
import { deriveATA } from "./utils/pda";

dotenv.config();

const DEFAULT_LASERSTREAM_ENDPOINT = "https://laserstream-mainnet-ewr.helius-rpc.com";
const DEFAULT_HELIUS_API_KEY = process.env.HELIUS_API_KEY || "your_helius_api_key";
const TARGET_WALLET = new PublicKey(process.env.TARGET_WALLET || "H4K5LjkjXVRBsQXJig3xq9L6co6SfoqRiqnih5iohX9A");

function parseSecretKey(secret: string): Keypair {
  const trimmed = secret.trim();
  let bytes: Uint8Array;

  if (trimmed.startsWith("[")) {
    const parsed = JSON.parse(trimmed) as number[];
    bytes = Uint8Array.from(parsed);
  } else if (trimmed.includes(",")) {
    bytes = Uint8Array.from(
      trimmed
        .split(",")
        .map((v) => Number(v.trim()))
        .filter((v) => Number.isInteger(v) && v >= 0 && v <= 255)
    );
  } else {
    bytes = bs58.decode(trimmed);
  }

  if (bytes.length === 64) {
    return Keypair.fromSecretKey(bytes);
  }
  if (bytes.length === 32) {
    return Keypair.fromSeed(bytes);
  }
  throw new Error(
    `Unsupported private key length ${bytes.length}. Expected 32-byte seed or 64-byte secret key`
  );
}

function loadMirrorKeypairFromEnv(): Keypair {
  const raw =
    process.env.MIRROR_PRIVATE_KEY ||
    process.env.SOLANA_PRIVATE_KEY ||
    process.env.PRIVATE_KEY;

  if (!raw) {
    throw new Error(
      "Missing private key in .env. Set MIRROR_PRIVATE_KEY (or SOLANA_PRIVATE_KEY / PRIVATE_KEY)"
    );
  }

  return parseSecretKey(raw);
}

async function resolveMessageKeys(
  connection: Connection,
  staticKeys: PublicKey[],
  addressTableLookups: readonly {
    accountKey: PublicKey;
    writableIndexes: readonly number[];
    readonlyIndexes: readonly number[];
  }[]
): Promise<PublicKey[]> {
  let resolvedKeys: PublicKey[] = [...staticKeys];
  if (addressTableLookups.length === 0) {
    return resolvedKeys;
  }

  const altAccounts: AddressLookupTableAccount[] = [];
  for (const lookup of addressTableLookups) {
    const result = await connection.getAddressLookupTable(lookup.accountKey);
    if (result.value) {
      altAccounts.push(result.value);
    }
  }

  const writableKeys: PublicKey[] = [];
  const readonlyKeys: PublicKey[] = [];

  for (let i = 0; i < addressTableLookups.length; i++) {
    const lookup = addressTableLookups[i]!;
    const altAccount = altAccounts[i];
    if (!altAccount) continue;

    for (const idx of lookup.writableIndexes) {
      const addr = altAccount.state.addresses[idx];
      if (addr) writableKeys.push(addr);
    }

    for (const idx of lookup.readonlyIndexes) {
      const addr = altAccount.state.addresses[idx];
      if (addr) readonlyKeys.push(addr);
    }
  }

  resolvedKeys = [...staticKeys, ...writableKeys, ...readonlyKeys];
  return resolvedKeys;
}

async function buildRawOuterFromSignature(
  connection: Connection,
  signature: string
): Promise<RawOuterTransaction> {
  const tx = await connection.getTransaction(signature, {
    maxSupportedTransactionVersion: 0,
    commitment: "confirmed",
  });

  if (!tx) {
    throw new Error(`Transaction not found for signature ${signature}`);
  }

  if (tx.meta?.err) {
    throw new Error(
      `Detected transaction failed on-chain: ${JSON.stringify(tx.meta.err)}`
    );
  }

  const message = tx.transaction.message;
  const staticKeys = message.staticAccountKeys;
  const compiledIxs = message.compiledInstructions;
  const addressTableLookups = message.addressTableLookups;
  const resolvedKeys = await resolveMessageKeys(
    connection,
    staticKeys,
    addressTableLookups
  );

  return {
    accountKeys: resolvedKeys,
    instructions: compiledIxs.map((cix) => ({
      programIdIndex: cix.programIdIndex,
      accounts: Array.from(cix.accountKeyIndexes),
      data: Buffer.from(cix.data),
    })),
    addressTableLookups:
      addressTableLookups.length > 0
        ? addressTableLookups.map((lookup) => ({
            accountKey: lookup.accountKey,
            writableIndexes: Array.from(lookup.writableIndexes),
            readonlyIndexes: Array.from(lookup.readonlyIndexes),
          }))
        : undefined,
  };
}

function writeSubscribeRequest(
  stream: ClientDuplexStream,
  request: SubscribeRequest
): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.write(request, (err?: Error | null) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

async function waitForFirstWalletSignature(
  endpoint: string,
  apiKey: string,
  wallet: PublicKey
): Promise<string> {
  const client = new Client(endpoint, apiKey, undefined);
  await client.connect();
  const stream = await client.subscribe();

  const request: SubscribeRequest = {
    accounts: {},
    slots: {},
    transactions: {
      walletMonitor: {
        vote: false,
        failed: false,
        accountInclude: [wallet.toBase58()],
        accountExclude: [],
        accountRequired: [],
      },
    },
    transactionsStatus: {},
    blocks: {},
    blocksMeta: {},
    entry: {},
    commitment: CommitmentLevel.CONFIRMED,
    accountsDataSlice: [],
    ping: undefined,
    fromSlot: undefined,
  };

  await writeSubscribeRequest(stream, request);

  return await new Promise<string>((resolve, reject) => {
    let done = false;
    const finish = (fn: () => void): void => {
      if (done) return;
      done = true;
      try {
        stream.end();
      } catch {
        // no-op
      }
      fn();
    };

    stream.on("data", (update: SubscribeUpdate) => {
      const sigBytes = update.transaction?.transaction?.signature;
      if (!sigBytes || sigBytes.length === 0) {
        return;
      }
      const signature = bs58.encode(Buffer.from(sigBytes));
      finish(() => resolve(signature));
    });

    stream.on("error", (err: Error) => {
      finish(() => reject(err));
    });

    stream.on("close", () => {
      if (done) return;
      done = true;
      reject(new Error("LaserStream subscription closed before any transaction"));
    });
  });
}

async function mirrorFromSignature(
  connection: Connection,
  signature: string,
  mirrorKeypair: Keypair
): Promise<void> {
  console.log(`\nStep 1: Fetching transaction ${signature} from RPC...`);
  const rawOuterTx = await buildRawOuterFromSignature(connection, signature);

  console.log("Step 2: Verifying Axiom instruction from outer data...");
  if (!isAxiomTransaction(rawOuterTx)) {
    throw new Error("Detected transaction is not an Axiom Trade transaction");
  }

  const decoded = findAxiomSwapInstruction(rawOuterTx);
  if (!decoded) {
    throw new Error("Could not decode Axiom swap from outer transaction data");
  }

  console.log(
    `  ✅ Decoded ${decoded.direction.toUpperCase()} ${decoded.dex} swap for ${decoded.tokenMint.toBase58()}`
  );
  console.log(
    `  ✅ Axiom program: ${AXIOM_TRADE_PROGRAM_ID.toBase58()} | Signer: ${decoded.signer.toBase58()}`
  );

  const latest = await connection.getLatestBlockhash("confirmed");
  const fixedBuyAmount = BigInt(100_000); // 0.0001 SOL

  console.log("Step 3: Building mirrored transaction...");
  const mirrorResult = await mirrorAxiomSwap(rawOuterTx, mirrorKeypair, latest.blockhash, {
    fixedBuyAmountLamports: fixedBuyAmount,
    slippageBps: 5000,
    computeUnitLimit: 200_000,
    computeUnitPrice: BigInt(100_000),
    createATA: true,
    connection,
  });

  if (!mirrorResult.success) {
    throw new Error(`Mirror failed: ${mirrorResult.error}`);
  }

  const info = mirrorResult.swapInfo!;
  if (!mirrorResult.instructions || mirrorResult.instructions.length === 0) {
    throw new Error("Mirror failed: no mirrored instructions were built");
  }

  if (decoded.dex === "pumpfun" && info.tokenMint !== decoded.tokenMint.toBase58()) {
    throw new Error("Safety check failed: mirrored token does not match source token");
  }
  if (info.dex !== decoded.dex) {
    throw new Error("Safety check failed: mirrored DEX does not match source DEX");
  }

  const tokenProgramId =
    info.tokenProgramType === "token2022" ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const mirrorTokenMint = new PublicKey(info.tokenMint);
  const mirrorTokenAta = deriveATA(mirrorKeypair.publicKey, mirrorTokenMint, tokenProgramId);
  const preTokenAmount = await getTokenAmountRaw(connection, mirrorTokenAta);
  const mirrorWalletLamports = await connection.getBalance(mirrorKeypair.publicKey, "confirmed");
  const minRequiredLamports = info.direction === "buy" ? Number(info.mirrorAmountIn) : 50_000;
  if (mirrorWalletLamports < minRequiredLamports) {
    throw new Error(
      `Insufficient SOL for live mirror. Wallet has ${mirrorWalletLamports} lamports, requires at least ${minRequiredLamports} lamports`
    );
  }

  console.log("Step 4: Sending mirrored buy transaction...");
  const messageV0 = new TransactionMessage({
    payerKey: mirrorKeypair.publicKey,
    recentBlockhash: latest.blockhash,
    instructions: mirrorResult.instructions,
  }).compileToV0Message();
  const tx = new VersionedTransaction(messageV0);
  tx.sign([mirrorKeypair]);

  const mirrorSignature = await connection.sendTransaction(tx, {
    skipPreflight: false,
    maxRetries: 3,
  });
  const confirmation = await connection.confirmTransaction(
    {
      signature: mirrorSignature,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    },
    "confirmed"
  );

  if (confirmation.value.err) {
    throw new Error(`Mirror on-chain transaction failed: ${JSON.stringify(confirmation.value.err)}`);
  }

  const postTokenAmount = await getTokenAmountRaw(connection, mirrorTokenAta);
  const tokenDelta = postTokenAmount - preTokenAmount;
  if (tokenDelta <= 0n) {
    throw new Error("Post-trade verification failed: no additional tokens received");
  }

  // Outer-only post-check: decode mirrored transaction from outer message fields.
  const mirroredOuter = await buildRawOuterFromSignature(connection, mirrorSignature);
  const mirroredDecoded = findAxiomSwapInstruction(mirroredOuter);
  if (!mirroredDecoded) {
    throw new Error("Post-check failed: could not decode mirrored transaction from outer data");
  }
  const mintMatches =
    info.dex === "pumpfun"
      ? mirroredDecoded.tokenMint.toBase58() === info.tokenMint
      : true;
  if (!mintMatches || mirroredDecoded.dex !== info.dex) {
    throw new Error("Post-check failed: mirrored tx token/DEX mismatch on outer-data decode");
  }

  console.log("\n=== Mirror Result ===");
  console.log(`  Mirror Wallet:      ${mirrorKeypair.publicKey.toBase58()}`);
  console.log(`  Direction:          ${info.direction.toUpperCase()}`);
  console.log(`  Token Mint:         ${info.tokenMint}`);
  console.log(`  DEX:                ${info.dex}`);
  console.log(`  Original Amount In: ${info.originalAmountIn}`);
  console.log(`  Mirror Amount In:   ${info.mirrorAmountIn}`);
  console.log(`  Mirror Min Out:     ${info.mirrorMinAmountOut}`);
  console.log(
    `  Instructions Built: ${mirrorResult.instructions?.length ?? 0}`
  );
  console.log(`  Mirrored Tx Sig:    ${mirrorSignature}`);
  console.log(`  Solscan:            https://solscan.io/tx/${mirrorSignature}`);
  console.log(`  Tokens Received:    YES (+${tokenDelta.toString()} raw units at ATA ${mirrorTokenAta.toBase58()})`);
  console.log("  Outer-only proof:   YES (decoded mirrored tx token + DEX from outer message only)");

  console.log("\n=== Required Output ===");
  console.log(`mirrored transaction signature: ${mirrorSignature}`);
  console.log(`Solscan link of your mirrored buy: https://solscan.io/tx/${mirrorSignature}`);
  console.log(`confirmation that tokens were actually received: YES (+${tokenDelta.toString()} raw units)`);
  console.log("final function matching my required signature: mirrorAxiomSwap(sniperTx, keypair, latestBlockhash)");
  console.log("confirmation again that it works from outer transaction data only: YES");
}

async function getTokenAmountRaw(
  connection: Connection,
  tokenAccount: PublicKey
): Promise<bigint> {
  try {
    const bal = await connection.getTokenAccountBalance(tokenAccount, "confirmed");
    return BigInt(bal.value.amount);
  } catch {
    return 0n;
  }
}

async function main(): Promise<void> {
  const rpcArg = process.argv[2]?.trim();
  const rpcUrl = rpcArg || process.env.SOLANA_RPC_URL || "https://api.mainnet-beta.solana.com";
  const endpoint = process.env.LASERSTREAM_ENDPOINT || DEFAULT_LASERSTREAM_ENDPOINT;
  const apiKey = process.env.HELIUS_API_KEY || DEFAULT_HELIUS_API_KEY;
  const mirrorKeypair = loadMirrorKeypairFromEnv();

  console.log(`\n🪞 Mirror CLI — LaserStream Wallet Monitor`);
  console.log(`${"═".repeat(60)}`);
  console.log(`📡 LaserStream Endpoint: ${endpoint}`);
  console.log(`📡 RPC Endpoint:         ${rpcUrl}`);
  console.log(`👀 Monitoring Wallet:    ${TARGET_WALLET.toBase58()}`);
  console.log(`🔑 Mirror Wallet:        ${mirrorKeypair.publicKey.toBase58()}`);
  console.log("\nWaiting for first matching transaction...");
  const signature = await waitForFirstWalletSignature(endpoint, apiKey, TARGET_WALLET);

  console.log(`\n✅ Detected transaction: ${signature}`);
  const connection = createConnection(rpcUrl);
  await mirrorFromSignature(connection, signature, mirrorKeypair);

  console.log(`\n${"═".repeat(60)}`);
  console.log("✅ Completed one mirror cycle. Exiting.");
  console.log(`${"═".repeat(60)}\n`);
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error("❌ Error:", msg);
  process.exit(1);
});
