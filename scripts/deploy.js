const hre = require("hardhat");

async function main() {
  // Get all signers
  const [deployer, signer1, signer2, signer3] = await hre.ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);
  console.log(
    "Account balance:",
    (await deployer.provider.getBalance(deployer.address)).toString(),
  );

  // Get chainId from the network
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;

  // Determine which signers to use based on the network
  let signers;
  if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    // Use local hardhat accounts for testing
    signers = [
      deployer.address,
      signer1.address,
      signer2.address,
      signer3.address,
    ];
  } else {
    // Use configured signers for production networks
    signers = hre.config.namedAccounts.signers[hre.network.name];
    if (!signers) {
      throw new Error(`No signers configured for network: ${hre.network.name}`);
    }
  }

  console.log("Using chainId:", chainId);
  console.log("Using signers:", signers);

  const LiberdusToken = await hre.ethers.getContractFactory("Liberdus");
  const liberdusToken = await LiberdusToken.deploy(signers, chainId);

  await liberdusToken.waitForDeployment();

  console.log("LiberdusToken deployed to:", await liberdusToken.getAddress());
  console.log("Initial signers:");
  signers.forEach((signer, index) => {
    console.log(`- Signer ${index + 1}:`, signer);
  });

  // Verify the contract on block explorer if not on local network
  if (hre.network.name !== "hardhat" && hre.network.name !== "localhost") {
    console.log("Waiting for block confirmations...");
    await liberdusToken.deploymentTransaction().wait(6);

    console.log("Verifying contract...");
    await hre.run("verify:verify", {
      address: await liberdusToken.getAddress(),
      constructorArguments: [signers, chainId],
    });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
