require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config();

// Define signer addresses for production networks
const SIGNER_1 = process.env.SIGNER_1 || "0x1111111111111111111111111111111111111111";
const SIGNER_2 = process.env.SIGNER_2 || "0x2222222222222222222222222222222222222222";
const SIGNER_3 = process.env.SIGNER_3 || "0x3333333333333333333333333333333333333333";
const SIGNER_4 = process.env.SIGNER_4 || "0x4444444444444444444444444444444444444444";

module.exports = {
  solidity: "0.8.20",
  defaultNetwork: "localhost",
  networks: {
    hardhat: {
      chainId: 31337,
      accounts: {
        mnemonic: process.env.MNEMONIC || "test test test test test test test test test test test junk",
      },
    },
    localhost: {
      url: "http://127.0.0.1:8545",
      accounts: [
        // These are hardhat default accounts. Safe to use for local testing.
        "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80",
        "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d",
        "0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a",
        "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6",
        "0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a",
        "0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba",
        "0x92db14e403b83dfe3df233f83dfa3a0d7096f21ca9b0d6d6b8d88b2b4ec1564e"

      ].filter((key) => key !== undefined),
    },
    polygon: {
      url: process.env.POLYGON_URL || "https://polygon-rpc.com",
      accounts: [process.env.PRIVATE_KEY].filter(Boolean),
      chainId: 137
    },
    mumbai: {
      url: process.env.MUMBAI_URL || "https://rpc-mumbai.maticvigil.com",
      accounts: [process.env.PRIVATE_KEY].filter(Boolean),
      chainId: 80001
    },
    amoy: {
      url: process.env.MUMBAI_URL || "https://rpc-amoy.polygon.technology/",
      accounts: [process.env.PRIVATE_KEY].filter(Boolean),
      chainId: 80002
    },
    bscTestnet: {
      url: process.env.BSC_TESTNET_URL || "https://bsc-testnet-dataseed.bnbchain.org",
      accounts: [process.env.PRIVATE_KEY].filter(Boolean),
      chainId: 97
    }
  },
  etherscan: {
    apiKey: {
      polygon: process.env.POLYGONSCAN_API_KEY,
      polygonMumbai: process.env.POLYGONSCAN_API_KEY,
      bscTestnet: process.env.BSCSCAN_API_KEY
    }
  },
  namedAccounts: {
    deployer: {
      default: 0
    },
    signers: {
      mainnet: [SIGNER_1, SIGNER_2, SIGNER_3, SIGNER_4],
      polygon: [SIGNER_1, SIGNER_2, SIGNER_3, SIGNER_4],
      mumbai: [SIGNER_1, SIGNER_2, SIGNER_3, SIGNER_4],
      amoy: [SIGNER_1, SIGNER_2, SIGNER_3, SIGNER_4],
      bscTestnet: [SIGNER_1, SIGNER_2, SIGNER_3, SIGNER_4],
    }
  }
};
