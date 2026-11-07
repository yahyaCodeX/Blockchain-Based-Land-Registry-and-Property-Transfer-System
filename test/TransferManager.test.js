const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deployWithParcel, docHash, NOTICE_PERIOD } = require("./fixture");

const PRICE = 12_500_000n; // PKR 1.25 crore

async function initiated() {
  const ctx = await deployWithParcel();
  await ctx.transfers.connect(ctx.ali).initiate(ctx.parcelId, ctx.ids.sara, PRICE, docHash("sale-deed"));
  return { ...ctx, tid: 1n };
}

async function taxCleared() {
  const ctx = await initiated();
  await ctx.transfers.connect(ctx.sara).accept(ctx.tid);
  await ctx.transfers.connect(ctx.tax).clearTax(ctx.tid, docHash("cvt-receipt"));
  return ctx;
}

describe("TransferManager - sale (mutation) state machine", function () {
  it("happy path: Initiated -> Accepted -> TaxCleared -> Completed", async function () {
    const { transfers, registry, registrar, tax, sara, ali, parcelId, ids } = await loadFixture(deployWithParcel);

    await expect(transfers.connect(ali).initiate(parcelId, ids.sara, PRICE, docHash("sale-deed")))
      .to.emit(transfers, "TransferInitiated").withArgs(1n, parcelId, ids.sara, ids.ali, PRICE, docHash("sale-deed"));
    await expect(transfers.connect(sara).accept(1n)).to.emit(transfers, "TransferAccepted");
    await expect(transfers.connect(tax).clearTax(1n, docHash("cvt-receipt")))
      .to.emit(transfers, "TaxCleared").withArgs(1n, docHash("cvt-receipt"), tax.address);

    await time.increase(NOTICE_PERIOD);
    await expect(transfers.connect(registrar).approve(1n))
      .to.emit(transfers, "TransferCompleted").withArgs(1n, parcelId, registrar.address)
      .and.to.emit(registry, "OwnershipChanged");

    expect(await registry.ownerOf(parcelId)).to.equal(ids.sara);
    const p = await registry.getParcel(parcelId);
    expect(p.version).to.equal(2);
    expect((await transfers.getTransfer(1n)).state).to.equal(4); // Completed
    expect(await transfers.openTransferOf(parcelId)).to.equal(0n);
  });

  it("only the current owner can initiate", async function () {
    const { transfers, sara, stranger, parcelId, ids } = await loadFixture(deployWithParcel);
    await expect(transfers.connect(sara).initiate(parcelId, ids.sara, PRICE, docHash("d")))
      .to.be.revertedWithCustomError(transfers, "NotOwner");
    await expect(transfers.connect(stranger).initiate(parcelId, ids.sara, PRICE, docHash("d")))
      .to.be.revertedWithCustomError(transfers, "NotOwner");
  });

  it("prevents double-selling: one open transfer per parcel", async function () {
    const { transfers, ali, parcelId, ids } = await loadFixture(initiated);
    await expect(transfers.connect(ali).initiate(parcelId, ids.bilal, PRICE, docHash("second-deed")))
      .to.be.revertedWithCustomError(transfers, "ParcelBusy").withArgs(1n);
  });

  it("only the named buyer can accept", async function () {
    const { transfers, bilal, tid } = await loadFixture(initiated);
    await expect(transfers.connect(bilal).accept(tid)).to.be.revertedWithCustomError(transfers, "NotBuyer");
  });

  it("rejects invalid buyer (self / zero) and zero price", async function () {
    const { transfers, ali, parcelId, ids } = await loadFixture(deployWithParcel);
    await expect(transfers.connect(ali).initiate(parcelId, ids.ali, PRICE, docHash("d")))
      .to.be.revertedWithCustomError(transfers, "InvalidBuyer");
    await expect(transfers.connect(ali).initiate(parcelId, ethers.ZeroHash, PRICE, docHash("d")))
      .to.be.revertedWithCustomError(transfers, "InvalidBuyer");
    await expect(transfers.connect(ali).initiate(parcelId, ids.sara, 0, docHash("d")))
      .to.be.revertedWithCustomError(transfers, "ZeroValue");
  });

  it("enforces step order (cannot clear tax before acceptance)", async function () {
    const { transfers, tax, tid } = await loadFixture(initiated);
    await expect(transfers.connect(tax).clearTax(tid, docHash("r")))
      .to.be.revertedWithCustomError(transfers, "BadState");
  });

  it("only tax authority clears tax; only registrar approves", async function () {
    const { transfers, sara, stranger, tid } = await loadFixture(initiated);
    await transfers.connect(sara).accept(tid);
    await expect(transfers.connect(stranger).clearTax(tid, docHash("r")))
      .to.be.revertedWithCustomError(transfers, "NotRole");
  });

  it("cannot approve during the public-notice window", async function () {
    const { transfers, registrar, tid } = await loadFixture(taxCleared);
    await expect(transfers.connect(registrar).approve(tid))
      .to.be.revertedWithCustomError(transfers, "NoticePeriodRunning");
  });

  it("registrar approval is role-gated", async function () {
    const { transfers, ali, tid } = await loadFixture(taxCleared);
    await time.increase(NOTICE_PERIOD);
    await expect(transfers.connect(ali).approve(tid)).to.be.revertedWithCustomError(transfers, "NotRole");
  });

  it("buyer or seller may cancel before tax; outsiders may not", async function () {
    const { transfers, sara, stranger, ali, parcelId, ids, tid } = await loadFixture(initiated);
    await expect(transfers.connect(stranger).cancel(tid)).to.be.revertedWithCustomError(transfers, "NotParty");
    await expect(transfers.connect(sara).cancel(tid)).to.emit(transfers, "TransferCancelled");
    // parcel is free again
    await transfers.connect(ali).initiate(parcelId, ids.bilal, PRICE, docHash("new"));
  });

  it("cannot cancel after tax has been paid (registrar must reject instead)", async function () {
    const { transfers, ali, registrar, tid } = await loadFixture(taxCleared);
    await expect(transfers.connect(ali).cancel(tid)).to.be.revertedWithCustomError(transfers, "BadState");
    await expect(transfers.connect(registrar).reject(tid, docHash("forged signature")))
      .to.emit(transfers, "TransferRejected");
  });

  it("cannot act on a completed transfer again (no replay)", async function () {
    const { transfers, registrar, tid } = await loadFixture(taxCleared);
    await time.increase(NOTICE_PERIOD);
    await transfers.connect(registrar).approve(tid);
    await expect(transfers.connect(registrar).approve(tid)).to.be.revertedWithCustomError(transfers, "BadState");
    await expect(transfers.connect(registrar).reject(tid, docHash("x"))).to.be.revertedWithCustomError(transfers, "BadState");
  });
});

describe("Cross-contract rules (Lien + Dispute + Transfer)", function () {
  it("a mortgaged parcel cannot be put up for sale", async function () {
    const { transfers, liens, bank, ali, parcelId, ids } = await loadFixture(deployWithParcel);
    await liens.connect(ali).grantLienConsent(parcelId, bank.address);
    await liens.connect(bank).registerLien(parcelId, 5_000_000n, docHash("loan"));
    await expect(transfers.connect(ali).initiate(parcelId, ids.sara, PRICE, docHash("d")))
      .to.be.revertedWithCustomError(transfers, "ParcelEncumbered");
  });

  it("a lien registered mid-transfer blocks completion until released", async function () {
    const { transfers, liens, bank, ali, registrar, parcelId, tid, registry, ids } = await loadFixture(taxCleared);
    await liens.connect(ali).grantLienConsent(parcelId, bank.address);
    await liens.connect(bank).registerLien(parcelId, 1_000_000n, docHash("loan"));
    await time.increase(NOTICE_PERIOD);
    await expect(transfers.connect(registrar).approve(tid)).to.be.revertedWithCustomError(transfers, "ParcelEncumbered");
    await liens.connect(bank).releaseLien(1n);
    await transfers.connect(registrar).approve(tid);
    expect(await registry.ownerOf(parcelId)).to.equal(ids.sara);
  });

  it("a court stay order freezes the parcel and blocks completion", async function () {
    const { transfers, disputes, court, registrar, parcelId, tid } = await loadFixture(taxCleared);
    await disputes.connect(court).openCase(parcelId, docHash("Suit 112/2026 Civil Judge Kotri"));
    await time.increase(NOTICE_PERIOD);
    await expect(transfers.connect(registrar).approve(tid)).to.be.revertedWithCustomError(transfers, "ParcelNotActive");
  });

  it("a court decree changing the owner invalidates a stale pending transfer", async function () {
    const { transfers, disputes, court, registrar, parcelId, tid, ids, registry } = await loadFixture(taxCleared);
    await disputes.connect(court).openCase(parcelId, docHash("Suit 7/2026"));
    await disputes.connect(court).resolveCase(1n, true, ids.bilal, docHash("decree-7-2026"));
    expect(await registry.ownerOf(parcelId)).to.equal(ids.bilal);
    expect(await registry.statusOf(parcelId)).to.equal(2); // Active again
    await time.increase(NOTICE_PERIOD);
    await expect(transfers.connect(registrar).approve(tid)).to.be.revertedWithCustomError(transfers, "StaleParcelVersion");
  });
});
