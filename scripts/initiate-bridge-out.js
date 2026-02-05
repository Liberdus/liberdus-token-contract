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
  const destinationChainId = process.env.DESTINATION_CHAIN_ID || 0;

  console.log("Using account:", deployer.address);
  console.log("Chain ID:", Number(chainId));
  console.log("Contract Type:", CONTRACT_TYPE);
  console.log("Contract Address:", CONTRACT_ADDRESS);

  // Attach to deployed contract
  const contract = await hre.ethers.getContractAt(CONTRACT_NAME, CONTRACT_ADDRESS);

  // Verify state
  const isPreLaunch = await contract.isPreLaunch();
  console.log("isPreLaunch:", isPreLaunch);
  if (isPreLaunch) {
    throw new Error("Contract is still in pre-launch mode. Bridge out not available.");
  }

  // Bridge out tokens
  const amount = ethers.parseUnits("100", 18); // Bridging out 100 tokens
  const targetAddress = deployer.address; // Sending to self on the other chain

  // Check balance first
  const balance = await contract.balanceOf(deployer.address);
  console.log("Current Balance:", ethers.formatUnits(balance, 18), "LIB");

  if (balance < amount) {
      throw new Error(`Insufficient balance to bridge out. Have ${ethers.formatUnits(balance, 18)}, need ${ethers.formatUnits(amount, 18)}`);
  }

  console.log(`\nBridging out ${ethers.formatUnits(amount, 18)} LIB to ${targetAddress} on destination chain...`);
  
  let tx;
  if (CONTRACT_TYPE === "SECONDARY") {
      console.log("Calling bridgeOut with destinationChainId:", destinationChainId);
      // bridgeOut(uint256 amount, address targetAddress, uint256 _chainId, uint256 destinationChainId)
      tx = await contract["bridgeOut(uint256,address,uint256,uint256)"](amount, targetAddress, chainId, destinationChainId);
  } else {
      // Primary contract: bridgeOut(uint256 amount, address targetAddress, uint256 _chainId)
      tx = await contract.bridgeOut(amount, targetAddress, chainId);
  }

  const receipt = await tx.wait();
  console.log("Transaction hash:", receipt.hash);

  const newBalance = await contract.balanceOf(deployer.address);
  console.log("New Balance:", ethers.formatUnits(newBalance, 18), "LIB");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });