# sol_internal_tx_parser

Parse Axiom Trade transactions on Solana, extract token mint, swap direction, and routing details, then rebuild and simulate swap instructions.

## Overview

This library parses transactions from the **Axiom Trade** program (`FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9`) on Solana. It currently supports swaps routed through **Pump.fun** (`6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`).

### Reference Transaction

The parser was built to handle transactions like:
- **Signature**: `4TphkyQv7wnYRkiD2WcujxafffAoNuT9HJn83AdGrBrM1TdQ8X2FFZVZ1oEaWV7n97wFnygoqupr48kf2zAjvGtM`
- **Action**: Swap 2.9612 SOL → 25,342,622.492742 EID on Pump.fun via Axiom Trade
- **Signer**: `H4K5LjkjXVRBsQXJig3xq9L6co6SfoqRiqnih5iohX9A`

## Features

### 1. Routing Layout Understanding
- Identifies the DEX used (Pump.fun)
- Determines pool orientation (SOL as quote/base)
- Maps all accounts in the instruction

### 2. Extraction
- **Correct mint** — token mint address from the instruction accounts
- **Correct direction** — SOL → Token (buy) or Token → SOL (sell)
- **Correct accounts mapping** — all 16 accounts mapped to their roles

### 3. Instruction Rebuild
- Derives all PDAs (bonding curve, event authority, creator vault, etc.)
- Generates proper Anchor-formatted instruction data with discriminators
- Supports both `buy_exact_in` and `sell_exact_in` instructions

### 4. ATA, WSOL, Token Program Handling
- **ATA**: Creates associated token accounts idempotently
- **WSOL**: Provides wrap/unwrap utilities for DEXes that require Wrapped SOL
- **Token Program**: Detects and handles both SPL Token and Token-2022

### 5. Pool, Vault, and Fee Account Handling
- **Pool orientation**: Pump.fun uses Token/SOL bonding curve (SOL as quote)
- **Vault swaps**: Derives creator vault PDA from bonding curve data
- **Fee accounts**: Includes fee recipient, fee config PDA, and fee program

### 6. Simulation
- Builds versioned transactions (V0) for simulation
- Simulates without signature verification
- Returns detailed logs, compute units, and error info

## Installation

```bash
npm install
```

## Build

```bash
npm run build
```

## Test

```bash
npm test
```

## CLI Usage

```bash
npx ts-node src/cli.ts <transaction-signature> [rpc-url]
```

Example:
```bash
npx ts-node src/cli.ts 4TphkyQv7wnYRkiD2WcujxafffAoNuT9HJn83AdGrBrM1TdQ8X2FFZVZ1oEaWV7n97wFnygoqupr48kf2zAjvGtM https://api.mainnet-beta.solana.com
```

## Programmatic Usage

```typescript
import {
  createConnection,
  parseAxiomTransaction,
  buildSwapInstructions,
  simulateTransaction,
  SwapDirection,
} from "sol_internal_tx_parser";
import { PublicKey } from "@solana/web3.js";

// Parse an existing transaction
const connection = createConnection("https://api.mainnet-beta.solana.com");
const result = await parseAxiomTransaction(connection, "<signature>");

console.log(result.tokenMint);      // Token mint address
console.log(result.direction);      // SOL_TO_TOKEN or TOKEN_TO_SOL
console.log(result.solAmount);      // SOL amount
console.log(result.tokenAmount);    // Token amount

// Build a new swap instruction
const rebuild = await buildSwapInstructions(connection, {
  signer: new PublicKey("<your-wallet>"),
  mint: new PublicKey("<token-mint>"),
  amountIn: BigInt(2_000_000_000),   // 2 SOL in lamports
  minAmountOut: BigInt(0),            // Set appropriate slippage
  direction: SwapDirection.SOL_TO_TOKEN,
});

// Simulate
const sim = await simulateTransaction(
  connection,
  rebuild.instructions,
  new PublicKey("<your-wallet>"),
);
console.log("Success:", sim.success);
console.log("Compute:", sim.unitsConsumed);
```

## Architecture

```
src/
├── index.ts                         # Main exports
├── constants.ts                     # Program IDs, discriminators, seeds
├── types.ts                         # TypeScript interfaces and enums
├── cli.ts                           # CLI entry point
├── parser/
│   ├── axiomParser.ts               # Parse Axiom Trade instructions
│   └── routingLayout.ts             # Analyze routing layout
├── builder/
│   └── instructionBuilder.ts        # Build swap instructions
├── simulator/
│   └── simulator.ts                 # Transaction simulation
├── utils/
│   ├── connection.ts                # RPC connection helper
│   ├── decoder.ts                   # Binary data encoding/decoding
│   └── pda.ts                       # PDA derivation helpers
└── test/
    └── parser.test.ts               # Unit tests
```

## Supported Instruction Types

| Instruction | Direction | Discriminator |
|---|---|---|
| `buy_exact_in` | SOL → Token | `faea0d7bd59c13ec` |
| `sell_exact_in` | Token → SOL | `9527de9bd37c981a` |
| `buy` | SOL → Token | `66063d1201daebea` |
| `sell` | Token → SOL | `33e685a4017f83ad` |
| `buy_max_out` | SOL → Token | `60b1cb75b741c4b1` |

## Pump.fun Account Layout

The Axiom Trade CPI into Pump.fun uses this account ordering:

| Index | Account | Writable | Signer |
|---|---|---|---|
| 0 | Global | No | No |
| 1 | Fee Recipient | Yes | No |
| 2 | Mint | Yes | No |
| 3 | Bonding Curve | Yes | No |
| 4 | Associated Bonding Curve | Yes | No |
| 5 | Associated User (ATA) | Yes | No |
| 6 | Signer / User | Yes | Yes |
| 7 | System Program | No | No |
| 8 | Token Program | No | No |
| 9 | Creator Vault | Yes | No |
| 10 | Event Authority | No | No |
| 11 | DEX Program (Pump.fun) | No | No |
| 12 | Global Volume Accumulator | Yes | No |
| 13 | User Volume Accumulator | Yes | No |
| 14 | Fee Config | No | No |
| 15 | Fee Program | No | No |

