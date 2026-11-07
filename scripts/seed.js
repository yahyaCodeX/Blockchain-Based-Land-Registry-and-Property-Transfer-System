/**
 * Deploys the system to a running node and fills it with realistic demo data
 * for the dashboard (parcels, sales in different states, liens, a court case).
 *
 *   npx hardhat node                                        # terminal 1
 *   npx hardhat run scripts/seed.js --network localhost     # terminal 2
 *   npm run dashboard                                       # then open http://localhost:3000
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const DAY = 86400;
const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));

async function main() {
  const [admin, kyc, patwari, registrar, bank, court, tax, ali, sara, bilal, zainab, kashif] = await ethers.getSigners();
  const D = async (n, ...a) => { const c = await (await ethers.getContractFactory(n)).deploy(...a); await c.waitForDeployment(); return c; };
  const w = async (p) => (await p).wait();

  const roles = await D("RoleManager", admin.address);
  const registry = await D("ParcelRegistry", await roles.getAddress());
  const liens = await D("LienRegistry", await roles.getAddress(), await registry.getAddress());
  const transfers = await D("TransferManager", await roles.getAddress(), await registry.getAddress(), await liens.getAddress(), 3 * DAY);
  const disputes = await D("DisputeRegistry", await roles.getAddress(), await registry.getAddress());
  const anchor = await D("StateAnchor", admin.address);
  await w(registry.setModules(await transfers.getAddress(), await disputes.getAddress()));
  for (const [r, who] of [["KYC_ROLE", kyc], ["PATWARI_ROLE", patwari], ["REGISTRAR_ROLE", registrar], ["BANK_ROLE", bank], ["COURT_ROLE", court], ["TAX_ROLE", tax]])
    await w(roles.grantRole(await roles[r](), who.address));

  // citizens (the name directory is OFF-CHAIN: only the commitment is on the ledger)
  const people = { "Ali Raza": ali, "Sara Memon": sara, "Bilal Shaikh": bilal, "Zainab Soomro": zainab, "Kashif Jamali": kashif };
  const ids = {}; const directory = {};
  let n = 1;
  for (const [name, signer] of Object.entries(people)) {
    ids[name] = h(`4130${n}-12345${n}7-${n}|salt-${n}`); n++;
    directory[ids[name]] = name;
    await w(roles.connect(kyc).verifyCitizen(signer.address, ids[name]));
  }

  // parcels: [district, mouza, khasra, owner, area sq ft, label]
  const parcelsIn = [
    [31, 101, "245/3", "Ali Raza", 5445, "Kotri, Jamshoro"],
    [31, 101, "246/1", "Sara Memon", 10890, "Kotri, Jamshoro"],
    [31, 104, "12/7", "Bilal Shaikh", 2722, "Manjhand, Jamshoro"],
    [41, 220, "88", "Zainab Soomro", 21780, "Qasimabad, Hyderabad"],
    [41, 220, "89/2", "Kashif Jamali", 4500, "Qasimabad, Hyderabad"],
    [41, 231, "301", "Ali Raza", 9000, "Latifabad, Hyderabad"],
  ];
  const labels = {};
  const pid = {};
  for (const [d, m, k, owner, area, place] of parcelsIn) {
    const id = await registry.parcelKey(d, m, k);
    pid[k] = id;
    labels[id] = { khasra: k, district: d, mouza: m, place };
    await w(registry.connect(patwari).proposeParcel(id, ids[owner], area, h(`fard-${k}`)));
    await w(registry.connect(registrar).approveParcel(id));
  }
  // one parcel still pending approval
  const pend = await registry.parcelKey(41, 231, "302");
  labels[pend] = { khasra: "302", district: 41, mouza: 231, place: "Latifabad, Hyderabad" };
  await w(registry.connect(patwari).proposeParcel(pend, ids["Kashif Jamali"], 3600, h("fard-302")));

  // 1) completed sale: Ali -> Sara (245/3)
  await w(transfers.connect(ali).initiate(pid["245/3"], ids["Sara Memon"], 12_500_000n, h("deed-1")));
  await w(transfers.connect(sara).accept(1n));
  await w(transfers.connect(tax).clearTax(1n, h("cvt-1")));
  await network.provider.send("evm_increaseTime", [3 * DAY]); await network.provider.send("evm_mine");
  await w(transfers.connect(registrar).approve(1n));

  // 2) sale in public-notice period: Zainab -> Kashif (88)
  await w(transfers.connect(zainab).initiate(pid["88"], ids["Kashif Jamali"], 31_000_000n, h("deed-2")));
  await w(transfers.connect(kashif).accept(2n));
  await w(transfers.connect(tax).clearTax(2n, h("cvt-2")));

  // 3) sale just initiated: Ali -> Bilal (301)
  await w(transfers.connect(ali).initiate(pid["301"], ids["Bilal Shaikh"], 18_000_000n, h("deed-3")));

  // 4) cancelled sale: Kashif -> Zainab (89/2)
  await w(transfers.connect(kashif).initiate(pid["89/2"], ids["Zainab Soomro"], 7_000_000n, h("deed-4")));
  await w(transfers.connect(zainab).cancel(4n));

  // lien: Sara mortgages 246/1 with the bank
  await w(liens.connect(sara).grantLienConsent(pid["246/1"], bank.address));
  await w(liens.connect(bank).registerLien(pid["246/1"], 5_000_000n, h("loan-1")));

  // court: inheritance suit freezes 12/7; second suit on 89/2 decided with ownership correction
  await w(disputes.connect(court).openCase(pid["12/7"], h("Suit 112/2026 Senior Civil Judge Kotri")));
  await w(disputes.connect(court).openCase(pid["89/2"], h("Suit 57/2026 Civil Judge Hyderabad")));
  await w(disputes.connect(court).resolveCase(2n, true, ids["Zainab Soomro"], h("decree 57/2026")));

  // public anchor checkpoint
  const blk = await ethers.provider.getBlock("latest");
  await w(anchor.anchor(blk.number, blk.hash, h("parcels-merkle-root")));

  const contracts = {
    RoleManager: await roles.getAddress(), ParcelRegistry: await registry.getAddress(), LienRegistry: await liens.getAddress(),
    TransferManager: await transfers.getAddress(), DisputeRegistry: await disputes.getAddress(), StateAnchor: await anchor.getAddress(),
  };
  const out = path.join(__dirname, "..", "dashboard", "data");
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "seed.json"), JSON.stringify({
    network: network.name, contracts, directory, labels,
    demoRoles: { bank: bank.address },
    note: "directory and labels are the department's OFF-CHAIN data; the chain only holds commitments and parcel keys",
  }, null, 2));
  console.log("Seeded. Contracts:", contracts);
  console.log("Now run: npm run dashboard  ->  http://localhost:3000");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
