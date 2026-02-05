const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer, signer1, signer2, signer3] = await hre.ethers.getSigners();

  // --- CONFIGURATION ---
  const LIBERDUS_ADDR = process.env.LIBERDUS_ADDR || "0x5FbDB2315678afecb367f032d93F642f64180aa3";
  const LIBERDUS_SEC_ADDR = process.env.LIBERDUS_SEC_ADDR || "0xe7f1725E7734CE288F8367e1Bb143E90bb3F0512";

  const CHAIN_ID_PRIMARY = 31337;
  const CHAIN_ID_SECONDARY = 31338;

  // Addresses to set as bridgeIn caller on each contract
  const BRIDGE_IN_CALLER_PRIMARY = process.env.BRIDGE_IN_CALLER_PRIMARY || "0xcd9511690e5d15575Fb033d17b6f6B021DF22600";
  const BRIDGE_IN_CALLER_SECONDARY = process.env.BRIDGE_IN_CALLER_SECONDARY || "0x79D6Bb4e74CE0e0DbD82B44d491aE207Ff247dD4";

  // Comma-separated recipient addresses for token and ETH transfers
  // Bridge callers are included automatically and deduplicated
  const RECIPIENTS = [...new Set([
    ...(BRIDGE_IN_CALLER_PRIMARY && ethers.isAddress(BRIDGE_IN_CALLER_PRIMARY) ? [BRIDGE_IN_CALLER_PRIMARY] : []),
    ...(BRIDGE_IN_CALLER_SECONDARY && ethers.isAddress(BRIDGE_IN_CALLER_SECONDARY) ? [BRIDGE_IN_CALLER_SECONDARY] : []),
    ...(process.env.RECIPIENTS || "")
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a && ethers.isAddress(a)),
  ].map((a) => a.toLowerCase()))];

  const TOKEN_AMOUNT = process.env.TOKEN_AMOUNT || "100";
  const ETH_AMOUNT = process.env.ETH_AMOUNT || "10";

  let signers;
  if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    signers = [deployer, signer1, signer2, signer3];
  } else {
    throw new Error("This script is designed for local networks only");
  }

  // --- HELPER ---
  async function requestAndSignOperation(contract, operationType, target, value, data) {
    const tx = await contract.requestOperation(operationType, target, value, data);
    const receipt = await tx.wait();
    const operationRequestedEvent = receipt.logs.find(
      (log) => log.fragment.name === "OperationRequested",
    );
    const operationId = operationRequestedEvent.args.operationId;

    for (let i = 0; i < 3; i++) {
      const messageHash = await contract.getOperationHash(operationId);
      const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
      await contract.connect(signers[i]).submitSignature(operationId, signature);
    }
    return operationId;
  }

  // Attach to deployed contracts
  const Liberdus = await ethers.getContractFactory("Liberdus");
  const liberdus = Liberdus.attach(LIBERDUS_ADDR);

  const LiberdusSecondary = await ethers.getContractFactory("LiberdusSecondary");
  const liberdusSecondary = LiberdusSecondary.attach(LIBERDUS_SEC_ADDR);

  console.log("Deployer:", deployer.address);
  console.log("Primary contract:", LIBERDUS_ADDR);
  console.log("Secondary contract:", LIBERDUS_SEC_ADDR);

  // ====================================================
  // 1. ETH TRANSFERS
  // ====================================================
  if (RECIPIENTS.length > 0) {
    console.log("\n--- Transferring ETH ---");
    const ethAmount = ethers.parseUnits(ETH_AMOUNT, "ether");
    for (const recipient of RECIPIENTS) {
      console.log(`Transferring ${ETH_AMOUNT} ETH to ${recipient}...`);
      const tx = await deployer.sendTransaction({ to: recipient, value: ethAmount });
      await tx.wait();
      console.log(`  Done.`);
    }
  }

  // ====================================================
  // 2. SET BRIDGE-IN CALLER
  // ====================================================
  // Primary: OpType 5 = SetBridgeInCaller
  if (BRIDGE_IN_CALLER_PRIMARY && ethers.isAddress(BRIDGE_IN_CALLER_PRIMARY)) {
    const currentPrimaryCaller = await liberdus.bridgeInCaller();
    if (currentPrimaryCaller.toLowerCase() === BRIDGE_IN_CALLER_PRIMARY.toLowerCase()) {
      console.log(`\nPrimary BridgeInCaller already set to ${BRIDGE_IN_CALLER_PRIMARY}, skipping.`);
    } else {
      console.log(`\n--- Setting BridgeInCaller on Primary to ${BRIDGE_IN_CALLER_PRIMARY} ---`);
      await requestAndSignOperation(liberdus, 5, BRIDGE_IN_CALLER_PRIMARY, 0, "0x");
      console.log("  Done.");
    }
  } else if (BRIDGE_IN_CALLER_PRIMARY) {
    console.log(`\nWarning: Invalid BRIDGE_IN_CALLER_PRIMARY address: ${BRIDGE_IN_CALLER_PRIMARY}`);
  }

  // Secondary: OpType 3 = SetBridgeInCaller
  if (BRIDGE_IN_CALLER_SECONDARY && ethers.isAddress(BRIDGE_IN_CALLER_SECONDARY)) {
    const currentSecondaryCaller = await liberdusSecondary.bridgeInCaller();
    if (currentSecondaryCaller.toLowerCase() === BRIDGE_IN_CALLER_SECONDARY.toLowerCase()) {
      console.log(`Secondary BridgeInCaller already set to ${BRIDGE_IN_CALLER_SECONDARY}, skipping.`);
    } else {
      console.log(`--- Setting BridgeInCaller on Secondary to ${BRIDGE_IN_CALLER_SECONDARY} ---`);
      await requestAndSignOperation(liberdusSecondary, 3, BRIDGE_IN_CALLER_SECONDARY, 0, "0x");
      console.log("  Done.");
    }
  } else if (BRIDGE_IN_CALLER_SECONDARY) {
    console.log(`\nWarning: Invalid BRIDGE_IN_CALLER_SECONDARY address: ${BRIDGE_IN_CALLER_SECONDARY}`);
  }

  // ====================================================
  // 3. TOKEN TRANSFERS
  // ====================================================
  if (RECIPIENTS.length > 0) {
    console.log("\n--- Transferring Tokens ---");
    const tokenAmount = ethers.parseUnits(TOKEN_AMOUNT, 18);

    for (const recipient of RECIPIENTS) {
      // Primary: try contract distribution (OpType 8) first, fall back to deployer transfer
      const contractBalance = await liberdus.balanceOf(await liberdus.getAddress());
      if (contractBalance >= tokenAmount) {
        console.log(`Distributing ${TOKEN_AMOUNT} LIB from Primary contract to ${recipient}...`);
        await requestAndSignOperation(liberdus, 8, recipient, tokenAmount, "0x");
      } else {
        const deployerPrimaryBal = await liberdus.balanceOf(deployer.address);
        if (deployerPrimaryBal >= tokenAmount) {
          console.log(`Transferring ${TOKEN_AMOUNT} LIB on Primary to ${recipient}...`);
          await liberdus.connect(deployer).transfer(recipient, tokenAmount);
        } else {
          console.log(`Skipping Primary token transfer to ${recipient}: insufficient balance`);
        }
      }

      // Secondary: regular transfer from deployer (no DistributeTokens op on secondary)
      const deployerSecBal = await liberdusSecondary.balanceOf(deployer.address);
      if (deployerSecBal >= tokenAmount) {
        console.log(`Transferring ${TOKEN_AMOUNT} LIB on Secondary to ${recipient}...`);
        await liberdusSecondary.connect(deployer).transfer(recipient, tokenAmount);
      } else {
        console.log(`Skipping Secondary token transfer to ${recipient}: insufficient balance`);
      }
    }

    // Print final balances
    console.log("\n--- Final Balances ---");
    for (const recipient of RECIPIENTS) {
      const primaryBal = await liberdus.balanceOf(recipient);
      const secondaryBal = await liberdusSecondary.balanceOf(recipient);
      const ethBal = await deployer.provider.getBalance(recipient);
      console.log(`${recipient}:`);
      console.log(`  Primary:   ${ethers.formatUnits(primaryBal, 18)} LIB`);
      console.log(`  Secondary: ${ethers.formatUnits(secondaryBal, 18)} LIB`);
      console.log(`  ETH:       ${ethers.formatUnits(ethBal, "ether")} ETH`);
    }
  }

  console.log("\n--- Setup Complete ---");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
