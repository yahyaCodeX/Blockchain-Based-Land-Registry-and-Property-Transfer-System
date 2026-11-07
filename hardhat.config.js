require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");
require("hardhat-gas-reporter");
require("solidity-coverage");
const { subtask } = require("hardhat/config");
const { TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD } = require("hardhat/builtin-tasks/task-names");
const path = require("path");

// Use the bundled solc-js compiler (npm "solc" package) so the project compiles
// fully offline / behind restrictive firewalls (no download from soliditylang.org).
subtask(TASK_COMPILE_SOLIDITY_GET_SOLC_BUILD, async (args, hre, runSuper) => {
  if (args.solcVersion === "0.8.24") {
    return {
      compilerPath: path.join(__dirname, "node_modules", "solc", "soljson.js"),
      isSolcJs: true,
      version: args.solcVersion,
      longVersion: "0.8.24+commit.e11b9ed9",
    };
  }
  return runSuper();
});

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.24",
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: "paris", // Besu/QBFT-compatible opcode set
    },
  },
  networks: {
    hardhat: {
      chainId: 31337,
      hardfork: "cancun",
      blockGasLimit: 30_000_000, // same as the proposed Besu genesis gasLimit
    },
    // Local Hyperledger Besu QBFT consortium node (see README "Deploying to Besu")
    besu: {
      url: process.env.BESU_RPC || "http://127.0.0.1:8545",
      chainId: 1337,
      gasPrice: 0,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
    // Optional public testnet used only for the state-root anchoring contract
    amoy: {
      url: process.env.AMOY_RPC || "https://rpc-amoy.polygon.technology",
      chainId: 80002,
      accounts: process.env.DEPLOYER_KEY ? [process.env.DEPLOYER_KEY] : [],
    },
  },
  gasReporter: {
    enabled: process.env.REPORT_GAS === "true",
    currency: "USD",
    outputFile: process.env.GAS_FILE,
    noColors: !!process.env.GAS_FILE,
  },
};
