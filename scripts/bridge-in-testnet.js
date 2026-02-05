const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const CONTRACT_ADDRESS = process.env.LIBERDUS_SECONDARY_ADDRESS;
  if (!CONTRACT_ADDRESS) {
    throw new Error("Set LIBERDUS_SECONDARY_ADDRESS in your .env file");
  }

  const [deployer] = await hre.ethers.getSigners();
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;

  console.log("Using account:", deployer.address);
  console.log("Chain ID:", chainId);

  // Attach to deployed contract
  const liberdusSecondary = await hre.ethers.getContractAt("LiberdusSecondary", CONTRACT_ADDRESS);

  // Verify state
  const isPreLaunch = await liberdusSecondary.isPreLaunch();
  console.log("isPreLaunch:", isPreLaunch);
  if (isPreLaunch) {
    throw new Error("Contract is still in pre-launch mode. Redeploy with updated constructor.");
  }

  const bridgeInCaller = await liberdusSecondary.bridgeInCaller();
  console.log("bridgeInCaller:", bridgeInCaller);
  if (bridgeInCaller.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Deployer is not the bridgeInCaller. Expected ${deployer.address}, got ${bridgeInCaller}`);
  }

  // Bridge in tokens
  const amount = ethers.parseUnits("10000", 18);
  const txId = ethers.id("testnet-bridge-in-1");

  console.log(`\nBridging in ${ethers.formatUnits(amount, 18)} LIB to ${deployer.address}...`);
  const tx = await liberdusSecondary.bridgeIn(deployer.address, amount, chainId, txId);
  const receipt = await tx.wait();
  console.log("Transaction hash:", receipt.hash);

  const balance = await liberdusSecondary.balanceOf(deployer.address);
  console.log("Balance:", ethers.formatUnits(balance, 18), "LIB");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
