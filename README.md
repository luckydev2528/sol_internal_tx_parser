# sol_internal_tx_parser

Parse Axiom Trade transactions on Solana to extract token mint address, bought amount, routing layout, and rebuild swap instructions for simulation.

## Features

- **Transaction Parsing**: Fetch and parse Axiom Trade transactions from Solana RPC
- **Routing Layout Detection**: Identify the underlying DEX (Pump.fun, Raydium, Jupiter, etc.)
- **Swap Extraction**: Extract correct mint, direction (SOL → token), amounts, and accounts
- **Instruction Rebuild**: Reconstruct swap instructions with proper:
  - ATA (Associated Token Account) creation
  - WSOL (Wrapped SOL) handling
  - Token program detection (SPL Token vs Token2022)
  - Pool orientation and vault swap accounts
  - Fee accounts
- **Simulation**: Validate rebuilt transactions pass simulation

## Installation

```bash
npm install
```

## Configuration

Copy `.env.example` to `.env` and set your Solana RPC endpoint:

```bash
cp .env.example .env
```

A free RPC endpoint from [Helius](https://www.helius.dev/) or [QuickNode](https://www.quicknode.com/) is recommended for best results.

## Usage

### Command Line

Parse a specific transaction:

```bash
npm run parse -- <TRANSACTION_SIGNATURE>
```

Example with the reference transaction:

```bash
npm run parse -- 4TphkyQv7wnYRkiD2WcujxafffAoNuT9HJn83AdGrBrM1TdQ8X2FFZVZ1oEaWV7n97wFnygoqupr48kf2zAjvGtM
```

### Programmatic API

```typescript
import { AxiomTransactionParser, InstructionRebuilder, TransactionSimulator } from "sol_internal_tx_parser";
import { PublicKey } from "@solana/web3.js";

const rpcEndpoint = "https://api.mainnet-beta.solana.com";

// Step 1: Parse a transaction
const parser = new AxiomTransactionParser(rpcEndpoint);
const routingInfo = await parser.parseTransaction("4TphkyQv...");

console.log(routingInfo.swap.tokenMint);     // Token mint address
console.log(routingInfo.swap.direction);      // "SOL_TO_TOKEN" or "TOKEN_TO_SOL"
console.log(routingInfo.swap.solAmount);      // SOL amount
console.log(routingInfo.swap.tokenAmount);    // Token amount
console.log(routingInfo.swap.platform);       // "pump_fun", "raydium", etc.

// Step 2: Rebuild the instruction
const rebuilder = new InstructionRebuilder(rpcEndpoint);
const rebuilt = await rebuilder.rebuildPumpFunBuy(
  routingInfo,
  new PublicKey("YOUR_WALLET"),
  2.9612,  // SOL amount
  1000     // 10% slippage in BPS
);

// Step 3: Simulate
const simulator = new TransactionSimulator(rpcEndpoint);
const result = await simulator.simulate(rebuilt.serializedTransaction);
console.log(result.success); // true if simulation passes
```

## Architecture

```
src/
  constants.ts   - Program IDs, discriminators, known accounts
  types.ts       - TypeScript type definitions
  parser.ts      - Transaction parser (fetch + decode Axiom Trade routing)
  rebuilder.ts   - Instruction rebuilder (reconstruct swap instructions)
  simulator.ts   - Transaction simulator
  utils.ts       - Utilities (ATA, WSOL, token program detection)
  index.ts       - Main entry point and API exports
  test.ts        - Unit tests
```

## How It Works

### Parsing Flow

1. **Fetch transaction** from Solana RPC using `getParsedTransaction`
2. **Identify Axiom Trade** instruction (program ID: `FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9`)
3. **Detect underlying DEX** from inner instructions (CPI calls)
4. **Extract swap details** using two methods:
   - **CPI Method**: Decode Pump.fun inner instructions (discriminator matching + TradeEvent parsing)
   - **Balance Method**: Compare pre/post token balances (universal fallback)
5. **Map accounts**: Extract bonding curve, fee recipient, creator vault, etc.

### Supported DEXs

| DEX | Program ID | Status |
|-----|-----------|--------|
| Pump.fun | `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P` | ✅ Full support |
| PumpSwap | `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA` | ✅ Detection |
| Jupiter | `JUP6LkbZbjS1jKKwapdHNy74zcZ3tLUZoi5QNyVTaV4` | ✅ Detection |
| Raydium | `675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8` | ✅ Detection |
| Orca | `whirLbMiicVdio4qvUfM5KAg6Ct8VwpYzGff3uctyCc` | ✅ Detection |
| Meteora | `LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo` | ✅ Detection |

## Testing

```bash
npm test
```

## Building

```bash
npm run build
```

## Reference Transaction

The reference transaction used for development:
- **Signature**: `4TphkyQv7wnYRkiD2WcujxafffAoNuT9HJn83AdGrBrM1TdQ8X2FFZVZ1oEaWV7n97wFnygoqupr48kf2zAjvGtM`
- **Signer**: `H4K5LjkjXVRBsQXJig3xq9L6co6SfoqRiqnih5iohX9A`
- **Swap**: 2.9612 SOL → 25,342,622.492742 EID on Pump.fun
- **Router**: Axiom Trade (`FLASHX8DrLbgeR8FcfNV1F5krxYcYMUdBkrP1EPBtxB9`)
