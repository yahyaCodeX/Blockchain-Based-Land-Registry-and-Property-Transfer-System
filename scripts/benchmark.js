/**
 * Performance benchmark: gas per operation, measured throughput and latency,
 * and projected throughput on a Hyperledger Besu QBFT consortium network.
 *
 *   npx hardhat node                                   # terminal 1
 *   npx hardhat run scripts/benchmark.js --network localhost   # terminal 2
 *
 * Writes reports/benchmark.json
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const N_SEQ = Number(process.env.N_SEQ || 200);     // sequential txs (automine)
const N_BATCH = Number(process.env.N_BATCH || 600); // txs packed into blocks (manual mining)
const BESU_BLOCK_GAS = 30_000_000;                  // genesis gasLimit we propose for Besu
const BESU_BLOCK_PERIOD_S = [1, 2, 5];              // QBFT blockperiodseconds options
const DAY = 86400;
const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

async function main() {
  const signers = await ethers.getSigners();
  const [admin, kyc, patwari, registrar, bank, court, tax] = signers;
  const D = async (n, ...a) => { const c = await (await ethers.getContractFactory(n)).deploy(...a); await c.waitForDeployment(); return c; };

  const roles = await D("RoleManager", admin.address);
  const registry = await D("ParcelRegistry", await roles.getAddress());
  const liens = await D("LienRegistry", await roles.getAddress(), await registry.getAddress());
  const transfers = await D("TransferManager", await roles.getAddress(), await registry.getAddress(), await liens.getAddress(), 0);
  const disputes = await D("DisputeRegistry", await roles.getAddress(), await registry.getAddress());
  await (await registry.setModules(await transfers.getAddress(), await disputes.getAddress())).wait();
  for (const [r, who] of [["KYC_ROLE", kyc], ["PATWARI_ROLE", patwari], ["REGISTRAR_ROLE", registrar], ["BANK_ROLE", bank], ["COURT_ROLE", court], ["TAX_ROLE", tax]])
    await (await roles.grantRole(await roles[r](), who.address)).wait();

  // ---- 1. Gas for one complete lifecycle -------------------------------------------
  const [seller, buyer] = [signers[10], signers[11]];
  const sid = h("seller"), bid = h("buyer");
  const gas = {};
  const g = async (label, txp) => { const r = await (await txp).wait(); gas[label] = Number(r.gasUsed); return r; };
  await g("verifyCitizen", roles.connect(kyc).verifyCitizen(seller.address, sid));
  await roles.connect(kyc).verifyCitizen(buyer.address, bid).then((t) => t.wait());
  const pid = await registry.parcelKey(31, 1, "life-1");
  await g("proposeParcel", registry.connect(patwari).proposeParcel(pid, sid, 4500, h("doc")));
  await g("approveParcel", registry.connect(registrar).approveParcel(pid));
  await g("grantLienConsent", liens.connect(seller).grantLienConsent(pid, bank.address));
  await g("registerLien", liens.connect(bank).registerLien(pid, 1_000_000n, h("loan")));
  await g("releaseLien", liens.connect(bank).releaseLien(1n));
  await g("initiate", transfers.connect(seller).initiate(pid, bid, 10_000_000n, h("deed")));
  await g("accept", transfers.connect(buyer).accept(1n));
  await g("clearTax", transfers.connect(tax).clearTax(1n, h("receipt")));
  await g("approve", transfers.connect(registrar).approve(1n));
  await g("openCase", disputes.connect(court).openCase(pid, h("suit")));
  await g("resolveCase(decree)", disputes.connect(court).resolveCase(1n, true, sid, h("decree")));
  const saleGas = gas.initiate + gas.accept + gas.clearTax + gas.approve;
  const registrationGas = gas.proposeParcel + gas.approveParcel;

  // ---- 2. Sequential latency (one tx per block, automine) ----------------------------
  const lat = [];
  const tSeq0 = Date.now();
  for (let i = 0; i < N_SEQ; i++) {
    const p = await registry.parcelKey(32, 2, `seq-${i}`);
    const t = Date.now();
    await (await registry.connect(patwari).proposeParcel(p, sid, 1000 + i, h(`d${i}`))).wait();
    lat.push(Date.now() - t);
  }
  const seqSec = (Date.now() - tSeq0) / 1000;
  lat.sort((a, b) => a - b);
  const pct = (q) => lat[Math.min(lat.length - 1, Math.floor(q * lat.length))];

  // ---- 3. Batched blocks (manual mining, 30M gas blocks) ----------------------------
  await network.provider.send("evm_setAutomine", [false]);
  let nonce = await ethers.provider.getTransactionCount(patwari.address, "pending");
  const tB0 = Date.now();
  const sent = [];
  for (let i = 0; i < N_BATCH; i++) {
    // key computed client-side (identical to ParcelRegistry.parcelKey) to avoid an RPC round-trip
    const p = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint16", "uint32", "string"], [33, 3, `batch-${i}`]));
    sent.push(await registry.connect(patwari).proposeParcel(p, sid, 1000 + i, h(`b${i}`), { nonce: nonce++, gasLimit: 150000 }));
  }
  const startBlock = await ethers.provider.getBlockNumber();
  let pending = N_BATCH, blocks = 0;
  while (pending > 0) {
    await network.provider.send("evm_mine");
    blocks++;
    const b = await ethers.provider.getBlock("latest");
    pending -= b.transactions.length;
    if (blocks > 100) break;
  }
  const tBatch = (Date.now() - tB0) / 1000;
  await network.provider.send("evm_setAutomine", [true]);
  const perBlock = [];
  for (let n = startBlock + 1; n <= startBlock + blocks; n++) {
    const b = await ethers.provider.getBlock(n);
    perBlock.push({ block: n, txs: b.transactions.length, gasUsed: Number(b.gasUsed), gasLimit: Number(b.gasLimit) });
  }
  const receipts = await Promise.all(sent.slice(0, 5).map((t) => t.wait()));

  // ---- 4. Storage per record (measured from receipts + layout) -----------------------
  const rc = receipts[0];
  const tx = await ethers.provider.getTransaction(rc.hash);
  const calldataBytes = (tx.data.length - 2) / 2;
  const logBytes = rc.logs.reduce((s, l) => s + (l.data.length - 2) / 2 + l.topics.length * 32, 0);
  const STATE_SLOTS_PER_PARCEL = 4; // ownerId, docHash, packed(area,updatedAt,version,status,proposedBy) = 2+... see report

  // ---- 5. Projection to Besu QBFT --------------------------------------------------
  const besu = BESU_BLOCK_PERIOD_S.map((s) => ({
    blockPeriodSeconds: s,
    registrationsTPS: +(BESU_BLOCK_GAS / gas.proposeParcel / s).toFixed(1),
    approveTxTPS: +(BESU_BLOCK_GAS / gas.approve / s).toFixed(1),
    completeSalesPerSecond: +(BESU_BLOCK_GAS / saleGas / s).toFixed(1),
    completeSalesPerDay: Math.floor((BESU_BLOCK_GAS / saleGas / s) * DAY),
  }));

  const out = {
    network: network.name,
    timestamp: new Date().toISOString(),
    gasPerOperation: gas,
    gasCompleteSale4Tx: saleGas,
    gasRegistration2Tx: registrationGas,
    sequential: {
      txs: N_SEQ, seconds: +seqSec.toFixed(2), tps: +(N_SEQ / seqSec).toFixed(1),
      latencyMs: { p50: pct(0.5), p95: pct(0.95), p99: pct(0.99), max: lat[lat.length - 1] },
    },
    batched: {
      txs: N_BATCH, blocksNeeded: blocks, seconds: +tBatch.toFixed(2), tps: +(N_BATCH / tBatch).toFixed(1),
      maxTxPerBlock: Math.max(...perBlock.map((b) => b.txs)), perBlock,
    },
    storage: { calldataBytesPerRegistration: calldataBytes, eventLogBytesPerRegistration: logBytes, stateSlotsPerParcel: STATE_SLOTS_PER_PARCEL },
    besuProjection: { blockGasLimit: BESU_BLOCK_GAS, rows: besu },
  };
  fs.mkdirSync(path.join(__dirname, "..", "reports"), { recursive: true });
  fs.writeFileSync(path.join(__dirname, "..", "reports", "benchmark.json"), JSON.stringify(out, null, 2));
  console.log(JSON.stringify(out, (k, v) => (k === "perBlock" ? undefined : v), 2));
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
