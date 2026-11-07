const { ethers } = require("hardhat");

const NOTICE_PERIOD = 3 * 24 * 60 * 60; // 3 days public-notice window

/** keccak256(CNIC || salt) - what NADRA-KYC would put on chain. */
function idCommitment(cnic, salt = "demo-salt") {
  return ethers.keccak256(ethers.toUtf8Bytes(`${cnic}|${salt}`));
}

/** Simulated off-chain document hash (in production: SHA-256 of the IPFS bundle). */
function docHash(label) {
  return ethers.keccak256(ethers.toUtf8Bytes(label));
}

async function deploySystem() {
  const [admin, kyc, patwari, registrar, registrar2, bank, bank2, court, tax, ali, sara, bilal, stranger] =
    await ethers.getSigners();

  const RoleManager = await ethers.getContractFactory("RoleManager");
  const roles = await RoleManager.deploy(admin.address);

  const ParcelRegistry = await ethers.getContractFactory("ParcelRegistry");
  const registry = await ParcelRegistry.deploy(await roles.getAddress());

  const LienRegistry = await ethers.getContractFactory("LienRegistry");
  const liens = await LienRegistry.deploy(await roles.getAddress(), await registry.getAddress());

  const TransferManager = await ethers.getContractFactory("TransferManager");
  const transfers = await TransferManager.deploy(
    await roles.getAddress(), await registry.getAddress(), await liens.getAddress(), NOTICE_PERIOD
  );

  const DisputeRegistry = await ethers.getContractFactory("DisputeRegistry");
  const disputes = await DisputeRegistry.deploy(await roles.getAddress(), await registry.getAddress());

  await registry.setModules(await transfers.getAddress(), await disputes.getAddress());

  // institutional roles
  await roles.grantRole(await roles.KYC_ROLE(), kyc.address);
  await roles.grantRole(await roles.PATWARI_ROLE(), patwari.address);
  await roles.grantRole(await roles.REGISTRAR_ROLE(), registrar.address);
  await roles.grantRole(await roles.REGISTRAR_ROLE(), registrar2.address);
  await roles.grantRole(await roles.BANK_ROLE(), bank.address);
  await roles.grantRole(await roles.BANK_ROLE(), bank2.address);
  await roles.grantRole(await roles.COURT_ROLE(), court.address);
  await roles.grantRole(await roles.TAX_ROLE(), tax.address);

  // citizens
  const ids = {
    ali: idCommitment("41303-1234567-1"),
    sara: idCommitment("41303-7654321-2"),
    bilal: idCommitment("42101-1111111-3"),
  };
  await roles.connect(kyc).verifyCitizen(ali.address, ids.ali);
  await roles.connect(kyc).verifyCitizen(sara.address, ids.sara);
  await roles.connect(kyc).verifyCitizen(bilal.address, ids.bilal);

  return {
    roles, registry, liens, transfers, disputes,
    admin, kyc, patwari, registrar, registrar2, bank, bank2, court, tax, ali, sara, bilal, stranger,
    ids,
  };
}

/** Deploy + register one active parcel owned by Ali (Jamshoro, mouza 101, khasra 245/3). */
async function deployWithParcel() {
  const ctx = await deploySystem();
  const parcelId = await ctx.registry.parcelKey(31, 101, "245/3");
  await ctx.registry.connect(ctx.patwari).proposeParcel(parcelId, ctx.ids.ali, 5445, docHash("fard-245-3"));
  await ctx.registry.connect(ctx.registrar).approveParcel(parcelId);
  return { ...ctx, parcelId };
}

module.exports = { deploySystem, deployWithParcel, idCommitment, docHash, NOTICE_PERIOD };
