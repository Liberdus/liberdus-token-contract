const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const CONTRACT_TYPE = process.env.CONTRACT_TYPE || "SECONDARY";
  let CONTRACT_ADDRESS;
  let CONTRACT_NAME;

  if (CONTRACT_TYPE === "PRIMARY") {
    CONTRACT_ADDRESS = process.env.LIBERDUS_TOKEN_ADDRESS;
    CONTRACT_NAME = "Liberdus";
  } else {
    CONTRACT_ADDRESS = process.env.LIBERDUS_SECONDARY_ADDRESS;
    CONTRACT_NAME = "LiberdusSecondary";
  }

  if (!CONTRACT_ADDRESS) {
    throw new Error(`Set ${CONTRACT_TYPE === "PRIMARY" ? "LIBERDUS_TOKEN_ADDRESS" : "LIBERDUS_SECONDARY_ADDRESS"} in your .env file`);
  }

  const [deployer] = await hre.ethers.getSigners();
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const sourceChainId = process.env.SOURCE_CHAIN_ID || 0;

  console.log("Using account:", deployer.address);
  console.log("Chain ID:", chainId);
  console.log("Contract Type:", CONTRACT_TYPE);
  console.log("Contract Address:", CONTRACT_ADDRESS);

  // Attach to deployed contract
  const contract = await hre.ethers.getContractAt(CONTRACT_NAME, CONTRACT_ADDRESS);

  // Verify state
  const isPreLaunch = await contract.isPreLaunch();
  console.log("isPreLaunch:", isPreLaunch);
  if (isPreLaunch) {
    throw new Error("Contract is still in pre-launch mode. Redeploy with updated constructor.");
  }

  const bridgeInCaller = await contract.bridgeInCaller();
  console.log("bridgeInCaller:", bridgeInCaller);
  if (bridgeInCaller.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer is not the bridgeInCaller. Expected ${deployer.address}, got ${bridgeInCaller}`);
  }

  // Bridge in tokens
  const amount = ethers.parseUnits("10000", 18);
  const txId = ethers.id("testnet-bridge-in-1");

  console.log(`\nBridging in ${ethers.formatUnits(amount, 18)} LIB to ${deployer.address}...`);
  
  let tx;
  if (CONTRACT_TYPE === "SECONDARY") {
      console.log("Calling bridgeIn with sourceChainId:", sourceChainId);
      // bridgeIn(address to, uint256 amount, uint256 _chainId, bytes32 txId, uint256 sourceChainId)
      tx = await contract["bridgeIn(address,uint256,uint256,bytes32,uint256)"](deployer.address, amount, chainId, txId, sourceChainId);
  } else {
      // Primary contract only has: bridgeIn(address to, uint256 amount, uint256 _chainId, bytes32 txId)
      tx = await contract.bridgeIn(deployer.address, amount, chainId, txId);
  }

  const receipt = await tx.wait();
  console.log("Transaction hash:", receipt.hash);

  const balance = await contract.balanceOf(deployer.address);
  console.log("Balance:", ethers.formatUnits(balance, 18), "LIB");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
