const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { deploySystem, idCommitment } = require("./fixture");

describe("RoleManager - identity, roles and key recovery", function () {
  it("binds one identity commitment to exactly one wallet (Sybil resistance)", async function () {
    const { roles, kyc, stranger, ids } = await loadFixture(deploySystem);
    // the same CNIC commitment cannot be bound to a second wallet
    await expect(roles.connect(kyc).verifyCitizen(stranger.address, ids.ali))
      .to.be.revertedWithCustomError(roles, "IdentityAlreadyBound");
  });

  it("refuses to bind a second identity to an already-bound wallet", async function () {
    const { roles, kyc, ali } = await loadFixture(deploySystem);
    await expect(roles.connect(kyc).verifyCitizen(ali.address, idCommitment("99999-0000000-0")))
      .to.be.revertedWithCustomError(roles, "WalletAlreadyBound");
  });

  it("only KYC officers can verify citizens", async function () {
    const { roles, stranger } = await loadFixture(deploySystem);
    await expect(roles.connect(stranger).verifyCitizen(stranger.address, idCommitment("1")))
      .to.be.revertedWithCustomError(roles, "AccessControlUnauthorizedAccount");
  });

  it("emits CitizenVerified and exposes idOf / walletOf", async function () {
    const { roles, kyc, stranger } = await loadFixture(deploySystem);
    const c = idCommitment("12345-1234567-9");
    await expect(roles.connect(kyc).verifyCitizen(stranger.address, c))
      .to.emit(roles, "CitizenVerified").withArgs(stranger.address, c, kyc.address);
    expect(await roles.idOf(stranger.address)).to.equal(c);
    expect(await roles.walletOf(c)).to.equal(stranger.address);
  });

  it("recovers a lost key only after the 2-day delay", async function () {
    const { roles, kyc, ali, stranger, ids } = await loadFixture(deploySystem);
    await roles.connect(kyc).requestRecovery(ids.ali, stranger.address);
    await expect(roles.connect(kyc).executeRecovery(ids.ali))
      .to.be.revertedWithCustomError(roles, "RecoveryNotReady");

    await time.increase(2 * 24 * 60 * 60);
    await expect(roles.connect(kyc).executeRecovery(ids.ali))
      .to.emit(roles, "RecoveryExecuted").withArgs(ids.ali, ali.address, stranger.address);

    expect(await roles.walletOf(ids.ali)).to.equal(stranger.address);
    expect(await roles.isVerified(ali.address)).to.equal(false);
  });

  it("lets the genuine owner cancel a malicious recovery attempt", async function () {
    const { roles, kyc, ali, stranger, ids } = await loadFixture(deploySystem);
    await roles.connect(kyc).requestRecovery(ids.ali, stranger.address);
    await expect(roles.connect(ali).cancelRecovery(ids.ali)).to.emit(roles, "RecoveryCancelled");
    await time.increase(3 * 24 * 60 * 60);
    await expect(roles.connect(kyc).executeRecovery(ids.ali))
      .to.be.revertedWithCustomError(roles, "NoPendingRecovery");
  });

  it("blocks third parties from cancelling a recovery", async function () {
    const { roles, kyc, sara, stranger, ids } = await loadFixture(deploySystem);
    await roles.connect(kyc).requestRecovery(ids.ali, stranger.address);
    await expect(roles.connect(sara).cancelRecovery(ids.ali))
      .to.be.revertedWithCustomError(roles, "NotAuthorised");
  });

  it("revocation unbinds wallet and identity", async function () {
    const { roles, kyc, bilal, ids } = await loadFixture(deploySystem);
    await expect(roles.connect(kyc).revokeCitizen(bilal.address)).to.emit(roles, "CitizenRevoked");
    expect(await roles.walletOf(ids.bilal)).to.equal(ethers.ZeroAddress);
  });
});
