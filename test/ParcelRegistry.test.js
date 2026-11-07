const { expect } = require("chai");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySystem, deployWithParcel, docHash } = require("./fixture");

describe("ParcelRegistry - registration and duplicate prevention", function () {
  it("derives a deterministic parcel key from district/mouza/khasra", async function () {
    const { registry } = await loadFixture(deploySystem);
    const a = await registry.parcelKey(31, 101, "245/3");
    const b = await registry.parcelKey(31, 101, "245/3");
    const c = await registry.parcelKey(31, 101, "245/4");
    expect(a).to.equal(b);
    expect(a).to.not.equal(c);
  });

  it("requires Patwari proposal + a DIFFERENT Registrar approval", async function () {
    const { registry, roles, patwari, ids } = await loadFixture(deploySystem);
    const pid = await registry.parcelKey(31, 101, "1/1");
    await registry.connect(patwari).proposeParcel(pid, ids.ali, 1000, docHash("x"));
    // give the patwari the registrar role as well and try to self-approve
    await roles.grantRole(await roles.REGISTRAR_ROLE(), patwari.address);
    await expect(registry.connect(patwari).approveParcel(pid))
      .to.be.revertedWithCustomError(registry, "SameOfficial");
  });

  it("goes Pending -> Active with events and counters", async function () {
    const { registry, patwari, registrar, ids } = await loadFixture(deploySystem);
    const pid = await registry.parcelKey(31, 101, "9/2");
    await expect(registry.connect(patwari).proposeParcel(pid, ids.ali, 1000, docHash("x")))
      .to.emit(registry, "ParcelProposed");
    expect(await registry.statusOf(pid)).to.equal(1); // Pending
    await expect(registry.connect(registrar).approveParcel(pid))
      .to.emit(registry, "ParcelApproved").withArgs(pid, registrar.address);
    expect(await registry.statusOf(pid)).to.equal(2); // Active
    expect(await registry.activeParcelCount()).to.equal(1n);
  });

  it("BLOCKS duplicate registration of the same parcel (core fraud)", async function () {
    const { registry, patwari, parcelId, ids } = await loadFixture(deployWithParcel);
    await expect(registry.connect(patwari).proposeParcel(parcelId, ids.sara, 5445, docHash("forged-fard")))
      .to.be.revertedWithCustomError(registry, "DuplicateParcel").withArgs(parcelId);
  });

  it("blocks duplicates even while the first proposal is still pending", async function () {
    const { registry, patwari, ids } = await loadFixture(deploySystem);
    const pid = await registry.parcelKey(31, 101, "77");
    await registry.connect(patwari).proposeParcel(pid, ids.ali, 1000, docHash("a"));
    await expect(registry.connect(patwari).proposeParcel(pid, ids.sara, 1000, docHash("b")))
      .to.be.revertedWithCustomError(registry, "DuplicateParcel");
  });

  it("rejection clears the pending entry so a corrected proposal can be made", async function () {
    const { registry, patwari, registrar, ids } = await loadFixture(deploySystem);
    const pid = await registry.parcelKey(31, 101, "88");
    await registry.connect(patwari).proposeParcel(pid, ids.ali, 1000, docHash("a"));
    await expect(registry.connect(registrar).rejectParcel(pid, docHash("area mismatch")))
      .to.emit(registry, "ParcelRejected");
    await registry.connect(patwari).proposeParcel(pid, ids.ali, 1200, docHash("a-corrected"));
    expect(await registry.statusOf(pid)).to.equal(1);
  });

  it("only Patwaris can propose and only Registrars can approve", async function () {
    const { registry, stranger, patwari, ids } = await loadFixture(deploySystem);
    const pid = await registry.parcelKey(1, 1, "1");
    await expect(registry.connect(stranger).proposeParcel(pid, ids.ali, 1, docHash("a")))
      .to.be.revertedWithCustomError(registry, "NotRole");
    await registry.connect(patwari).proposeParcel(pid, ids.ali, 1, docHash("a"));
    await expect(registry.connect(stranger).approveParcel(pid))
      .to.be.revertedWithCustomError(registry, "NotRole");
  });

  it("rejects zero owner / area / document hash", async function () {
    const { registry, patwari, ids } = await loadFixture(deploySystem);
    const pid = await registry.parcelKey(1, 1, "z");
    await expect(registry.connect(patwari).proposeParcel(pid, ethers.ZeroHash, 1, docHash("a")))
      .to.be.revertedWithCustomError(registry, "ZeroValue");
    await expect(registry.connect(patwari).proposeParcel(pid, ids.ali, 0, docHash("a")))
      .to.be.revertedWithCustomError(registry, "ZeroValue");
    await expect(registry.connect(patwari).proposeParcel(pid, ids.ali, 1, ethers.ZeroHash))
      .to.be.revertedWithCustomError(registry, "ZeroValue");
  });

  it("nobody (not even admin) can change an owner directly", async function () {
    const { registry, admin, parcelId, ids } = await loadFixture(deployWithParcel);
    await expect(registry.connect(admin).transferOwnership(parcelId, ids.sara, docHash("x")))
      .to.be.revertedWithCustomError(registry, "NotModule");
    await expect(registry.connect(admin).courtOrderedTransfer(parcelId, ids.sara, docHash("x")))
      .to.be.revertedWithCustomError(registry, "NotModule");
    await expect(registry.connect(admin).setFrozen(parcelId, true))
      .to.be.revertedWithCustomError(registry, "NotModule");
  });

  it("gives banks an instant ownership check", async function () {
    const { registry, parcelId, ids } = await loadFixture(deployWithParcel);
    const [owns, status, version] = await registry.verifyOwnership(parcelId, ids.ali);
    expect(owns).to.equal(true);
    expect(status).to.equal(2);
    expect(version).to.equal(1);
    const [owns2] = await registry.verifyOwnership(parcelId, ids.sara);
    expect(owns2).to.equal(false);
  });

  it("module wiring can be locked permanently by governance", async function () {
    const { registry, admin, stranger } = await loadFixture(deploySystem);
    await expect(registry.connect(stranger).setModules(stranger.address, stranger.address))
      .to.be.revertedWithCustomError(registry, "NotRole");
    await registry.connect(admin).lockModules();
    await expect(registry.connect(admin).setModules(stranger.address, stranger.address))
      .to.be.revertedWithCustomError(registry, "ModulesAreLocked");
  });

  it("emergency pause halts registration", async function () {
    const { registry, admin, patwari, ids } = await loadFixture(deploySystem);
    await registry.connect(admin).pause();
    const pid = await registry.parcelKey(1, 1, "p");
    await expect(registry.connect(patwari).proposeParcel(pid, ids.ali, 1, docHash("a")))
      .to.be.revertedWithCustomError(registry, "EnforcedPause");
    await registry.connect(admin).unpause();
    await registry.connect(patwari).proposeParcel(pid, ids.ali, 1, docHash("a"));
  });
});
