# Blockchain land registry and property transfer: a consortium prototype

**Course:** CS-491 Blockchain Technologies and Applications, Complex Engineering Problem (CEP), Scenario A
**Institution:** Mehran University of Engineering and Technology, Jamshoro

| Member | Roll No. |
|---|---|
| Muhammad Yahya | 22CS001 |
| Shehzad | 22CS049 |
| Muzzamil | 22CS073 |

A provincial land revenue department wants three things: an end to fraudulent duplicate registrations, property transfers that take days instead of weeks, and instant ownership checks for banks. This repository contains the smart-contract core of a **permissioned consortium chain (Hyperledger Besu, QBFT)**. Its state is periodically anchored to a public chain for outside verifiability.

## Architecture (contracts)

```
                     +------------------+
                     |   RoleManager    |  roles + citizen identity commitments + key recovery
                     +--------+---------+
            hasRole / idOf    |
   +--------------+-----------+-----------+-----------------+
   |              |                       |                 |
+--v-----------+  |  transferOwnership  +-v--------------+  |
|ParcelRegistry|<-+---------------------|TransferManager |  |
| (Fard / RoR) |<----------+            +-------+--------+  |
+------^-------+ setFrozen |  isEncumbered      |           |
       |  courtOrdered     |            +-------v--------+  |
       |  Transfer   +-----+---------+  | LienRegistry   |<-+
       +-------------|DisputeRegistry|  | (bank charges) |
                     +---------------+  +----------------+

   StateAnchor (public chain): periodic consortium block hash + Merkle root of parcels
```

| Contract | Responsibility |
|---|---|
| `RoleManager` | OpenZeppelin AccessControl roles (Registrar, Patwari, Bank, Court, Tax, KYC). One-to-one binding of a hashed CNIC commitment to a wallet. Key recovery with a 2-day objection delay. |
| `ParcelRegistry` | Deterministic parcel key `keccak256(district, mouza, khasra)`, so a duplicate registration reverts. Two-official registration (Patwari proposes, a different Registrar approves). Only modules can change owners. Emergency pause. Instant `verifyOwnership` for banks. |
| `TransferManager` | Sale state machine: Initiated → Accepted → TaxCleared → (3-day public notice) → Completed / Cancelled / Rejected. One open transfer per parcel. Version pinning. |
| `LienRegistry` | Owner consent plus a bank registers a mortgage. While a lien is active the parcel cannot be sold. Only the lien holder can release it. |
| `DisputeRegistry` | Court stay (freezes the parcel) and decree (appends a corrective ownership entry; history is preserved). |
| `StateAnchor` | Deployed on a public chain (e.g., Polygon Amoy). Stores monotonic checkpoints of consortium state. |

Only hashes of documents (scanned Fard, sale deed, tax receipt, decree) go on-chain. The files themselves live in the department's document store or a private IPFS cluster.

## Prerequisites

* Node.js ≥ 18 (tested on v22) and npm
* Python 3 with `pip install slither-analyzer` (optional, for static analysis)
* Docker (optional, for the 4-node Besu network)

The project compiles with the **bundled solc-js 0.8.24** (`npm` package `solc`), so it needs no compiler download and works offline or behind a university proxy. See `hardhat.config.js`.

## Quick start

```bash
npm install --legacy-peer-deps
npm run compile
npm test                 # 47 tests
npm run test:gas         # tests + per-function gas table
npm run coverage         # statement / branch coverage
npm run demo             # end-to-end story used in the viva demo
```

## Web dashboard

```bash
npx hardhat node          # terminal 1 (leave running)
npm run seed              # terminal 2: deploys + fills demo parcels, sales, liens, court cases
npm run dashboard         # then open http://localhost:3000
```
Shows KPIs, the parcel register, sales in every state, liens and court cases, the ownership audit trail, contract addresses, the latest public anchor, and a **bank ownership check** that calls `verifyOwnership` live. Names and places come from an off-chain directory (`dashboard/data/seed.json`). The chain stores only commitments and hashes.

## Deploying

### 1. Local Hardhat network (what the report's measurements use)
```bash
npx hardhat node                      # terminal 1 (30M gas blocks, chainId 31337)
npm run deploy:local                  # terminal 2 -> deployments/localhost.json
npm run benchmark                     # -> reports/benchmark.json
```

### 2. Hyperledger Besu QBFT consortium (4 validators)
```bash
cd besu-network
docker run --rm -v $PWD:/data hyperledger/besu:24.12.2 operator generate-blockchain-config \
  --config-file=/data/qbftConfigFile.json --to=/data/networkFiles --private-key-file-name=key
# copy networkFiles/genesis.json -> ./genesis.json and each keys/<addr>/key -> node1..node4/
docker compose up -d
cd ..
DEPLOYER_KEY=0x... npx hardhat run scripts/deploy.js --network besu
```
The genesis file uses `zeroBaseFee` and `--min-gas-price=0`, so citizens never need cryptocurrency: gas only meters computation.

### 3. Public anchor (optional)
```bash
DEPLOYER_KEY=0x... AMOY_RPC=https://... npx hardhat run scripts/deploy.js --network amoy
```
(Only `StateAnchor` is meaningful on the public chain.)

## Measured results (local Hardhat node, 30M block gas limit)

| Operation | Gas |
|---|---|
| verifyCitizen | 93,873 |
| proposeParcel + approveParcel | 123,631 + 61,504 = 185,135 |
| Complete sale (initiate + accept + clearTax + approve) | 380,763 |
| registerLien / releaseLien | 171,134 / 33,355 |
| openCase / resolveCase (with decree) | 178,985 / 69,563 |
| Full system deployment | 5,552,680 |

* Sequential, 200 tx: about 120 to 130 tx/s, with latency p50 of about 5 ms and p95 of about 10 ms (local, single node).
* Block packing: **242 `proposeParcel` tx per 30M-gas block**, measured. This matches 30,000,000 / 123,631.
* Besu QBFT projection at a 2 s block period: about 121 registrations/s, or about 39 complete sales/s (about 3.4 M sales/day).

The full outputs are in `reports/` (`gas-report.txt`, `benchmark.json`, `coverage-summary.txt`, `slither-*.txt`, `demo-output.txt`).

## Static analysis

```bash
npm run slither
```
Slither 0.11.6 ran 102 detectors and reported **4 findings, 1 of which was fixed** (an unindexed event address). The other 3 are `block.timestamp` comparisons, which are accepted: the delays last days, and QBFT validators are known institutions, so the few seconds of timestamp drift a validator could introduce do not matter. See report §4.3.

## Repository layout

```
contracts/        6 Solidity contracts
test/             47 Mocha/Chai tests (fixture.js holds the shared deployment)
scripts/          deploy.js, demo.js, benchmark.js, seed.js
dashboard/        web dashboard (server.js, index.html, app.js, style.css)
besu-network/     QBFT genesis config + docker-compose for 4 validators
reports/          gas, coverage, slither, benchmark, demo outputs
deployments/      addresses written by deploy.js
```

## Limitations (prototype)

* Identity commitments are created by a trusted KYC role. There is no live NADRA integration.
* There is no front-end. Interaction is through scripts, tests, or any EVM wallet/console.
* Contracts are not upgradeable by design. Governance replaces modules through `setModules` and then locks them, so a new version means a redeploy plus a migration (see report §5.4).
* This code is not production-audited.

## License
MIT
