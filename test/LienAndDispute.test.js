const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployWithParcel, docHash } = require("./fixture");

describe("LienRegistry - bank mortgages", function () {
  it("requires owner consent before a bank can register a lien", async function () {
    const { liens, bank, parcelId } = await loadFixture(deployWithParcel);
    await expect(liens.connect(bank).registerLien(parcelId, 1n, docHash("loan")))
      .to.be.revertedWithCustomError(liens, "NoConsent");
  });

  it("only the owner can consent and only to a licensed bank", async function () {
    const { liens, sara, ali, bank, stranger, parcelId } = await loadFixture(deployWithParcel);
    await expect(liens.connect(sara).grantLienConsent(parcelId, bank.address))
      .to.be.revertedWithCustomError(liens, "NotOwner");
    await expect(liens.connect(ali).grantLienConsent(parcelId, stranger.address))
      .to.be.revertedWithCustomError(liens, "NotBank");
  });

  it("consent is single-use and bank-specific", async function () {
    const { liens, ali, bank, bank2, parcelId } = await loadFixture(deployWithParcel);
    await liens.connect(ali).grantLienConsent(parcelId, bank.address);
    await expect(liens.connect(bank2).registerLien(parcelId, 1n, docHash("l")))
      .to.be.revertedWithCustomError(liens, "NoConsent");
    await expect(liens.connect(bank).registerLien(parcelId, 1n, docHash("l")))
      .to.emit(liens, "LienRegistered");
    await expect(liens.connect(bank).registerLien(parcelId, 1n, docHash("l2")))
      .to.be.revertedWithCustomError(liens, "NoConsent");
  });

  it("only the lien-holding bank can release, and only once", async function () {
    const { liens, ali, bank, bank2, parcelId } = await loadFixture(deployWithParcel);
    await liens.connect(ali).grantLienConsent(parcelId, bank.address);
    await liens.connect(bank).registerLien(parcelId, 10n, docHash("l"));
    expect(await liens.isEncumbered(parcelId)).to.equal(true);
    await expect(liens.connect(bank2).releaseLien(1n)).to.be.revertedWithCustomError(liens, "NotLienHolder");
    await expect(liens.connect(bank).releaseLien(1n)).to.emit(liens, "LienReleased");
    expect(await liens.isEncumbered(parcelId)).to.equal(false);
    await expect(liens.connect(bank).releaseLien(1n)).to.be.revertedWithCustomError(liens, "LienNotActive");
  });

  it("cannot register a lien on a frozen parcel", async function () {
    const { liens, disputes, court, ali, bank, parcelId } = await loadFixture(deployWithParcel);
    await liens.connect(ali).grantLienConsent(parcelId, bank.address);
    await disputes.connect(court).openCase(parcelId, docHash("suit"));
    await expect(liens.connect(bank).registerLien(parcelId, 1n, docHash("l")))
      .to.be.revertedWithCustomError(liens, "ParcelNotActive");
  });
});

describe("DisputeRegistry - courts", function () {
  it("only courts can open cases", async function () {
    const { disputes, stranger, parcelId } = await loadFixture(deployWithParcel);
    await expect(disputes.connect(stranger).openCase(parcelId, docHash("s")))
      .to.be.revertedWithCustomError(disputes, "NotCourt");
  });

  it("multiple open cases keep the parcel frozen until all are resolved", async function () {
    const { disputes, registry, court, parcelId } = await loadFixture(deployWithParcel);
    await disputes.connect(court).openCase(parcelId, docHash("s1"));
    await disputes.connect(court).openCase(parcelId, docHash("s2"));
    expect(await disputes.openCaseCount(parcelId)).to.equal(2n);
    await disputes.connect(court).resolveCase(1n, false, ethers.ZeroHash, docHash("d1"));
    expect(await registry.statusOf(parcelId)).to.equal(3); // still Frozen
    await disputes.connect(court).resolveCase(2n, false, ethers.ZeroHash, docHash("d2"));
    expect(await registry.statusOf(parcelId)).to.equal(2); // Active
  });

  it("a decree appends a corrective ownership entry (history preserved)", async function () {
    const { disputes, registry, court, parcelId, ids } = await loadFixture(deployWithParcel);
    await disputes.connect(court).openCase(parcelId, docHash("s"));
    await expect(disputes.connect(court).resolveCase(1n, true, ids.bilal, docHash("decree")))
      .to.emit(registry, "OwnershipChanged")
      .withArgs(parcelId, ids.ali, ids.bilal, 2, docHash("decree"), await disputes.getAddress());
  });

  it("cannot resolve a case twice", async function () {
    const { disputes, court, parcelId } = await loadFixture(deployWithParcel);
    await disputes.connect(court).openCase(parcelId, docHash("s"));
    await disputes.connect(court).resolveCase(1n, false, ethers.ZeroHash, docHash("d"));
    await expect(disputes.connect(court).resolveCase(1n, false, ethers.ZeroHash, docHash("d")))
      .to.be.revertedWithCustomError(disputes, "CaseNotOpen");
  });

  it("cannot freeze a parcel that does not exist", async function () {
    const { disputes, registry, court } = await loadFixture(deployWithParcel);
    const ghost = await registry.parcelKey(99, 99, "ghost");
    await expect(disputes.connect(court).openCase(ghost, docHash("s")))
      .to.be.revertedWithCustomError(registry, "InvalidStatus");
  });
});

describe("StateAnchor - public-chain checkpoints", function () {
  it("only governance anchors; block numbers must increase", async function () {
    const [gov, other] = await ethers.getSigners();
    const A = await ethers.getContractFactory("StateAnchor");
    const a = await A.deploy(gov.address);
    await expect(a.connect(other).anchor(10, docHash("b"), docHash("r")))
      .to.be.revertedWithCustomError(a, "OwnableUnauthorizedAccount");
    await expect(a.anchor(10, docHash("b"), docHash("r"))).to.emit(a, "Anchored");
    await expect(a.anchor(10, docHash("b2"), docHash("r2"))).to.be.revertedWithCustomError(a, "NonMonotonic");
    await a.anchor(20, docHash("b2"), docHash("r2"));
    expect(await a.checkpointCount()).to.equal(2n);
    expect((await a.latest()).consortiumBlock).to.equal(20n);
  });
});
