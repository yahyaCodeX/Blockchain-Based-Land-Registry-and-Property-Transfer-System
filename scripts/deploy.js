/**
 * Deploys the full land-registry system and wires the modules.
 *   npx hardhat run scripts/deploy.js                 # in-process Hardhat network
 *   npx hardhat node  &  npx hardhat run scripts/deploy.js --network localhost
 *   npx hardhat run scripts/deploy.js --network besu  # consortium QBFT network
 *
 * Writes deployed addresses to deployments/<network>.json
 */
const { ethers, network } = require("hardhat");
const fs = require("fs");
const path = require("path");

const NOTICE_PERIOD = Number(process.env.NOTICE_PERIOD || 3 * 24 * 60 * 60);

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Network: ${network.name}  Deployer: ${deployer.address}`);

  const gasUsed = {};
  async function deploy(name, ...args) {
    const F = await ethers.getContractFactory(name);
    const c = await F.deploy(...args);
    const rcpt = await c.deploymentTransaction().wait();
    gasUsed[name] = Number(rcpt.gasUsed);
    console.log(`  ${name.padEnd(16)} ${await c.getAddress()}  gas=${rcpt.gasUsed}`);
    return c;
  }

  const roles = await deploy("RoleManager", deployer.address);
  const registry = await deploy("ParcelRegistry", await roles.getAddress());
  const liens = await deploy("LienRegistry", await roles.getAddress(), await registry.getAddress());
  const transfers = await deploy("TransferManager", await roles.getAddress(), await registry.getAddress(), await liens.getAddress(), NOTICE_PERIOD);
  const disputes = await deploy("DisputeRegistry", await roles.getAddress(), await registry.getAddress());
  const anchor = await deploy("StateAnchor", deployer.address);

  await (await registry.setModules(await transfers.getAddress(), await disputes.getAddress())).wait();
  console.log("  modules wired (ParcelRegistry -> TransferManager, DisputeRegistry)");

  const out = {
    network: network.name,
    chainId: Number((await ethers.provider.getNetwork()).chainId),
    deployedAt: new Date().toISOString(),
    noticePeriodSeconds: NOTICE_PERIOD,
    contracts: {
      RoleManager: await roles.getAddress(),
      ParcelRegistry: await registry.getAddress(),
      LienRegistry: await liens.getAddress(),
      TransferManager: await transfers.getAddress(),
      DisputeRegistry: await disputes.getAddress(),
      StateAnchor: await anchor.getAddress(),
    },
    deploymentGas: gasUsed,
    totalDeploymentGas: Object.values(gasUsed).reduce((a, b) => a + b, 0),
  };
  fs.mkdirSync(path.join(__dirname, "..", "deployments"), { recursive: true });
  const file = path.join(__dirname, "..", "deployments", `${network.name}.json`);
  fs.writeFileSync(file, JSON.stringify(out, null, 2));
  console.log(`Total deployment gas: ${out.totalDeploymentGas}\nSaved -> ${file}`);
}

main().catch((e) => { console.error(e); process.exitCode = 1; });
