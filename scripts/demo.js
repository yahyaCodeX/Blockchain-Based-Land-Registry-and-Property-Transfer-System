/**
 * End-to-end story used in the 10-minute demo.
 *   npx hardhat run scripts/demo.js
 *
 * Story: Ali owns plot 245/3 in mouza 101, district Jamshoro. A fraudster tries to
 * register it again (blocked). Ali mortgages it with a bank (bank verifies instantly),
 * tries to sell while mortgaged (blocked), repays, sells to Sara in days not weeks.
 * Then a court dispute freezes it and a decree corrects ownership.
 */
const { ethers, network } = require("hardhat");

const DAY = 24 * 60 * 60;
const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const short = (x) => `${x.slice(0, 10)}…`;
let step = 0;
const say = (msg) => console.log(`\n[${++step}] ${msg}`);
const ok = (msg) => console.log(`    ✔ ${msg}`);
const blocked = (msg) => console.log(`    ✖ BLOCKED: ${msg}`);

async function expectRevert(p, label) {
  try { await (await p).wait(); console.log("    !! unexpectedly succeeded"); }
  catch (e) {
    const m = (e.shortMessage || e.message).match(/custom error '([^']+)'|reverted with custom error '([^']+)'/);
    blocked(`${label} -> ${m ? (m[1] || m[2]) : e.shortMessage || e.message}`);
  }
}

async function main() {
  const [admin, kyc, patwari, registrar, bank, court, tax, ali, sara, bilal, fraudster] = await ethers.getSigners();
  const D = async (n, ...a) => (await ethers.getContractFactory(n)).deploy(...a);

  say("Deploying consortium contracts (RoleManager, ParcelRegistry, LienRegistry, TransferManager, DisputeRegistry)");
  const roles = await D("RoleManager", admin.address);
  const registry = await D("ParcelRegistry", await roles.getAddress());
  const liens = await D("LienRegistry", await roles.getAddress(), await registry.getAddress());
  const transfers = await D("TransferManager", await roles.getAddress(), await registry.getAddress(), await liens.getAddress(), 3 * DAY);
  const disputes = await D("DisputeRegistry", await roles.getAddress(), await registry.getAddress());
  await registry.setModules(await transfers.getAddress(), await disputes.getAddress());
  for (const [r, who] of [["KYC_ROLE", kyc], ["PATWARI_ROLE", patwari], ["REGISTRAR_ROLE", registrar], ["BANK_ROLE", bank], ["COURT_ROLE", court], ["TAX_ROLE", tax]])
    await roles.grantRole(await roles[r](), who.address);
  ok(`deployed on '${network.name}', 6 institutional roles granted`);

  say("NADRA-style KYC binds identity commitments (hash of CNIC+salt) to wallets");
  const id = { ali: h("41303-1234567-1|s1"), sara: h("41303-7654321-2|s2"), bilal: h("42101-1111111-3|s3") };
  await roles.connect(kyc).verifyCitizen(ali.address, id.ali);
  await roles.connect(kyc).verifyCitizen(sara.address, id.sara);
  await roles.connect(kyc).verifyCitizen(bilal.address, id.bilal);
  ok(`Ali=${short(id.ali)} Sara=${short(id.sara)} Bilal=${short(id.bilal)}  (no CNIC on chain)`);

  say("Patwari digitises plot 245/3 (district 31, mouza 101); a different Registrar approves");
  const pid = await registry.parcelKey(31, 101, "245/3");
  await registry.connect(patwari).proposeParcel(pid, id.ali, 5445, h("fard+map+mutation scans"));
  await registry.connect(registrar).approveParcel(pid);
  ok(`parcel ${short(pid)} ACTIVE, owner Ali, 5445 sq ft (1 kanal)`);

  say("Fraudster-patwari tries to register the same plot again under another name");
  await roles.grantRole(await roles.PATWARI_ROLE(), fraudster.address);
  await expectRevert(registry.connect(fraudster).proposeParcel(pid, id.bilal, 5445, h("forged fard")), "duplicate registration");

  say("Bank verifies ownership instantly (no visit to the patwar khana)");
  const [owns, , ver] = await registry.verifyOwnership(pid, id.ali);
  ok(`verifyOwnership(Ali) = ${owns}, record version ${ver}`);

  say("Ali consents, bank registers a PKR 5,000,000 mortgage");
  await liens.connect(ali).grantLienConsent(pid, bank.address);
  await liens.connect(bank).registerLien(pid, 5_000_000n, h("loan agreement"));
  ok(`encumbered = ${await liens.isEncumbered(pid)}`);

  say("Ali tries to sell the mortgaged plot to Sara");
  await expectRevert(transfers.connect(ali).initiate(pid, id.sara, 12_500_000n, h("deed")), "sale of mortgaged land");

  say("Loan repaid; bank releases the lien");
  await liens.connect(bank).releaseLien(1n);
  ok(`encumbered = ${await liens.isEncumbered(pid)}`);

  say("Sale to Sara: initiate -> accept -> tax cleared -> 3-day notice -> registrar approves");
  const t0 = (await ethers.provider.getBlock("latest")).timestamp;
  await transfers.connect(ali).initiate(pid, id.sara, 12_500_000n, h("sale deed 2026-11"));
  await expectRevert(transfers.connect(ali).initiate(pid, id.bilal, 13_000_000n, h("second deed")), "double-selling to Bilal");
  await transfers.connect(sara).accept(1n);
  await transfers.connect(tax).clearTax(1n, h("stamp duty + CVT + 236C/236K receipt"));
  await expectRevert(transfers.connect(registrar).approve(1n), "approval before notice period ends");
  await network.provider.send("evm_increaseTime", [3 * DAY]);
  await network.provider.send("evm_mine");
  const rc = await (await transfers.connect(registrar).approve(1n)).wait();
  const t1 = (await ethers.provider.getBlock("latest")).timestamp;
  ok(`owner is now ${(await registry.ownerOf(pid)) === id.sara ? "Sara" : "??"}; elapsed ledger time ${((t1 - t0) / DAY).toFixed(1)} days; approve gas ${rc.gasUsed}`);

  say("Bilal files a suit claiming inheritance; civil court issues a stay");
  await disputes.connect(court).openCase(pid, h("Suit 112/2026, Senior Civil Judge Kotri"));
  ok(`status = ${["None", "Pending", "Active", "Frozen"][Number(await registry.statusOf(pid))]}`);
  await expectRevert(transfers.connect(sara).initiate(pid, id.ali, 1n, h("x")), "sale of frozen land");

  say("Court decree: Bilal is the rightful owner -> corrective entry appended (history kept)");
  await disputes.connect(court).resolveCase(1n, true, id.bilal, h("decree 112/2026"));
  const p = await registry.getParcel(pid);
  ok(`owner ${p.ownerId === id.bilal ? "Bilal" : "??"}, status ${["None", "Pending", "Active", "Frozen"][Number(p.status)]}, version ${p.version}`);

  say("Full audit trail from events (what an auditor / court would read)");
  const evs = await registry.queryFilter(registry.filters.OwnershipChanged(pid));
  for (const e of evs) console.log(`    v${e.args.version}: ${short(e.args.fromId)} -> ${short(e.args.toId)}  via ${e.args.module === (await transfers.getAddress()) ? "TransferManager" : "DisputeRegistry"}  block ${e.blockNumber}`);

  say("Lost phone: Sara's key is recovered after biometric re-verification + 2-day delay");
  const newKey = ethers.Wallet.createRandom().address;
  await roles.connect(kyc).requestRecovery(id.sara, newKey);
  await network.provider.send("evm_increaseTime", [2 * DAY]);
  await network.provider.send("evm_mine");
  await roles.connect(kyc).executeRecovery(id.sara);
  ok(`Sara's identity now bound to ${short(newKey)} - no land re-registration needed`);

  console.log("\nDemo complete.");
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
