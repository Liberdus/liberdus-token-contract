const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer] = await hre.ethers.getSigners();

  console.log("Deploying LiberdusSecondary with the account:", deployer.address);
  console.log(
    "Account balance:",
    (await deployer.provider.getBalance(deployer.address)).toString(),
  );

  // Get chainId from the network
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;

  // Use configured signers for the network
  const signerAddresses = hre.config.namedAccounts.signers[hre.network.name];
  if (!signerAddresses) {
    throw new Error(`No signers configured for network: ${hre.network.name}`);
  }

  console.log("Using chainId:", chainId);
  console.log("Using signers:", signerAddresses);

  // Deploy LiberdusSecondary
  const LiberdusSecondary = await hre.ethers.getContractFactory("LiberdusSecondary");
  const liberdusSecondary = await LiberdusSecondary.deploy(signerAddresses, chainId);

  await liberdusSecondary.waitForDeployment();

  const contractAddress = await liberdusSecondary.getAddress();
  console.log("LiberdusSecondary deployed to:", contractAddress);
  console.log("Initial signers:");
  signerAddresses.forEach((signer, index) => {
    console.log(`  Signer ${index + 1}:`, signer);
  });
  console.log("BridgeInCaller set to signer 1:", signerAddresses[0]);

  // Wait for block confirmations then verify
  console.log("Waiting for block confirmations...");
  await liberdusSecondary.deploymentTransaction().wait(6);

  console.log("Verifying contract...");
  try {
    await hre.run("verify:verify", {
      address: contractAddress,
      constructorArguments: [signerAddresses, chainId],
    });
    console.log("Contract verified successfully");
  } catch (error) {
    console.error("Verification failed:", error.message);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
