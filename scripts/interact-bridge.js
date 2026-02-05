const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer, signer1, signer2, signer3] = await hre.ethers.getSigners();

  // --- CONFIGURATION ---
  // Update these addresses if they change in future deployments
  const LIBERDUS_ADDR = "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const LIBERDUS_SEC_ADDR = "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

  const CHAIN_ID_PRIMARY = 31337;
  const CHAIN_ID_SECONDARY = 31338;
  const balanceOnly = process.env.BALANCE_ONLY === "true" || process.env.BALANCE_ONLY === "1";

  console.log("Interacting with contracts...");
  console.log("Deployer:", deployer.address);
  console.log("Signer 1:", signer1.address);
  console.log("Signer 2:", signer2.address);

  // Attach to contracts
  const Liberdus = await ethers.getContractFactory("Liberdus");
  const liberdus = Liberdus.attach(LIBERDUS_ADDR);

  const LiberdusSecondary = await ethers.getContractFactory("LiberdusSecondary");
  const liberdusSecondary = LiberdusSecondary.attach(LIBERDUS_SEC_ADDR);

  // ====================================================
  // TOKEN & ETH BALANCE CHECK
  // ====================================================
  console.log("\n--- Token & ETH Balances ---");
  const accounts = [
    { name: "Deployer", address: deployer.address },
    { name: "Signer 1", address: signer1.address },
    { name: "Signer 2", address: signer2.address },
    { name: "Signer 3", address: signer3.address },
  ];
  for (const account of accounts) {
    const primaryBal = await liberdus.balanceOf(account.address);
    const secondaryBal = await liberdusSecondary.balanceOf(account.address);
    const ethBal = await deployer.provider.getBalance(account.address);
    console.log(`${account.name} (${account.address}):`);
    console.log(`  Primary:   ${ethers.formatUnits(primaryBal, 18)} LIB`);
    console.log(`  Secondary: ${ethers.formatUnits(secondaryBal, 18)} LIB`);
    console.log(`  ETH:       ${ethers.formatUnits(ethBal, "ether")} ETH`);
  }

  if (balanceOnly) {
    console.log("\n--- Balance check complete ---");
    return;
  }

  // ====================================================
  // 1. PRIMARY CHAIN ACTIVITY
  // ====================================================
  console.log("\n--- Primary Chain (Liberdus) Activities ---");

  // Check deployer balance
  const deployerBalPrimary = await liberdus.balanceOf(deployer.address);
  console.log(`Deployer Balance: ${ethers.formatUnits(deployerBalPrimary, 18)} LIB`);

  if (deployerBalPrimary > 0n) {
    // Transfer tokens to Signer 1
    // const transferAmount = ethers.parseUnits("1000", 18);
    // console.log(`Transferring ${ethers.formatUnits(transferAmount, 18)} LIB to Signer 1...`);
    // await liberdus.connect(deployer).transfer(signer1.address, transferAmount);

    // Signer 1 Bridges Out
    console.log("Signer 1 bridging out to Secondary...");
    const bridgeAmount = ethers.parseUnits("5", 18);

    // bridgeOut(amount, target, chainId)
    const tx = await liberdus.connect(signer1).bridgeOut(bridgeAmount, signer1.address, CHAIN_ID_PRIMARY);
    await tx.wait();
    console.log("Signer 1 bridge out successful.");
    console.log(`Signer 1 Remaining Balance: ${ethers.formatUnits(await liberdus.balanceOf(signer1.address), 18)} LIB`);
  } else {
    console.log("Skipping Primary activities: Deployer has no balance.");
  }

  // console.log("\n--- DONE ---");
  // process.exit(0);



  // ====================================================
  // 2. SECONDARY CHAIN ACTIVITY
  // ====================================================
  console.log("\n--- Secondary Chain (LiberdusSecondary) Activities ---");

  // Check deployer balance on Secondary (assuming simulated environment or previous bridge-in)
  const deployerBalSecondary = await liberdusSecondary.balanceOf(deployer.address);
  console.log(`Deployer Balance: ${ethers.formatUnits(deployerBalSecondary, 18)} LIB`);

  if (deployerBalSecondary > 0n) {
    // Transfer tokens to Signer 2
    // const transferAmount = ethers.parseUnits("50", 18);
    // console.log(`Transferring ${ethers.formatUnits(transferAmount, 18)} LIB to Signer 2...`);
    // await liberdusSecondary.connect(deployer).transfer(signer2.address, transferAmount);

    // Signer 2 Bridges Out back to Primary
    console.log("Signer 2 bridging out to Primary...");
    const bridgeAmount = ethers.parseUnits("1", 18);

    // LiberdusSecondary bridgeOut(amount, target, chainId, destinationChainId)
    // Using the 4-argument overload
    const tx = await liberdusSecondary
      .connect(signer2)
    ["bridgeOut(uint256,address,uint256,uint256)"](
      bridgeAmount,
      signer2.address,
      CHAIN_ID_SECONDARY,
      CHAIN_ID_PRIMARY
    );
    await tx.wait();
    console.log("Signer 2 bridge out successful.");
    console.log(`Signer 2 Remaining Balance: ${ethers.formatUnits(await liberdusSecondary.balanceOf(signer2.address), 18)} LIB`);
  } else {
    console.log("Skipping Secondary activities: Deployer has no balance (did you run the deploy script with bridge-in enabled?).");
  }

  console.log("\n--- Interaction Complete ---");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });