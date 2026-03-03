const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer, signer1, signer2, signer3] = await hre.ethers.getSigners();

  // --- CONFIGURATION ---
  const LIBERDUS_ADDR = process.env.LIBERDUS_TOKEN_ADDRESS;
  const LIBERDUS_SEC_ADDR = process.env.LIBERDUS_SECONDARY_ADDRESS;
  const VAULT_ADDR = process.env.VAULT_ADDRESS;

  // Addresses to set as bridgeIn caller on each contract
  const BRIDGE_IN_CALLER_PRIMARY = process.env.BRIDGE_IN_CALLER_PRIMARY;
  const BRIDGE_IN_CALLER_SECONDARY = process.env.BRIDGE_IN_CALLER_SECONDARY;

  // Comma-separated recipient addresses for token and ETH transfers
  // Bridge callers are included automatically and deduplicated
  const RECIPIENTS = [...new Set([
    ...(BRIDGE_IN_CALLER_PRIMARY && ethers.isAddress(BRIDGE_IN_CALLER_PRIMARY) ? [BRIDGE_IN_CALLER_PRIMARY] : []),
    ...(BRIDGE_IN_CALLER_SECONDARY && ethers.isAddress(BRIDGE_IN_CALLER_SECONDARY) ? [BRIDGE_IN_CALLER_SECONDARY] : []),
    ...(process.env.RECIPIENTS || signer1.address + "," + signer2.address + "," + signer3.address)
      .split(",")
      .map((a) => a.trim())
      .filter((a) => a && ethers.isAddress(a)),
  ].map((a) => a.toLowerCase()))];

  const TOKEN_AMOUNT = process.env.TOKEN_AMOUNT || "100";
  const ETH_AMOUNT = process.env.ETH_AMOUNT || "10";
  const SECONDARY_BRIDGE_IN_ENABLED = process.env.SECONDARY_BRIDGE_IN_ENABLED;
  const SECONDARY_BRIDGE_OUT_ENABLED = process.env.SECONDARY_BRIDGE_OUT_ENABLED;
  const SECONDARY_MIN_BRIDGE_OUT_AMOUNT = process.env.SECONDARY_MIN_BRIDGE_OUT_AMOUNT;
  const VAULT_BRIDGE_OUT_ENABLED = process.env.VAULT_BRIDGE_OUT_ENABLED;

  const OP_TYPES = {
    PRIMARY: Object.freeze({
      SET_BRIDGE_IN_CALLER: 5,
      DISTRIBUTE_TOKENS: 8,
    }),
    SECONDARY: Object.freeze({
      SET_BRIDGE_IN_CALLER: 0,
      SET_BRIDGE_IN_ENABLED: 3,
      SET_BRIDGE_OUT_ENABLED: 4,
      SET_MIN_BRIDGE_OUT_AMOUNT: 5,
    }),
    VAULT: Object.freeze({
      SET_BRIDGE_OUT_ENABLED: 2,
    }),
  };

  let signers;
  if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    signers = [deployer, signer1, signer2, signer3];
  } else {
    throw new Error("This script is designed for local networks only");
  }

  // --- HELPER ---
  function parseOptionalBoolean(rawValue, envName) {
    if (rawValue === undefined || rawValue === null || rawValue === "") {
      return null;
    }

    const normalized = String(rawValue).trim().toLowerCase();
    if (normalized === "true" || normalized === "1") {
      return true;
    }
    if (normalized === "false" || normalized === "0") {
      return false;
    }
    throw new Error(`${envName} must be one of: true, false, 1, 0`);
  }

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
  let vault = null;
  if (VAULT_ADDR && ethers.isAddress(VAULT_ADDR)) {
    const Vault = await ethers.getContractFactory("Vault");
    vault = Vault.attach(VAULT_ADDR);
  }

  console.log("Deployer:", deployer.address);
  console.log("Primary contract:", LIBERDUS_ADDR);
  console.log("Secondary contract:", LIBERDUS_SEC_ADDR);
  if (vault) {
    console.log("Vault contract:", VAULT_ADDR);
  }

  // Validate that addresses map to expected interfaces to avoid silent misconfiguration.
  try {
    await liberdusSecondary.symbol();
  } catch (error) {
    throw new Error(`LIBERDUS_SECONDARY_ADDRESS is not a LiberdusSecondary/ERC20 contract: ${LIBERDUS_SEC_ADDR}`);
  }
  if (vault) {
    try {
      await vault.token();
    } catch (error) {
      throw new Error(`VAULT_ADDRESS is not a Vault contract: ${VAULT_ADDR}`);
    }
  }

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
      await requestAndSignOperation(liberdus, OP_TYPES.PRIMARY.SET_BRIDGE_IN_CALLER, BRIDGE_IN_CALLER_PRIMARY, 0, "0x");
      console.log("  Done.");
    }
  } else if (BRIDGE_IN_CALLER_PRIMARY) {
    console.log(`\nWarning: Invalid BRIDGE_IN_CALLER_PRIMARY address: ${BRIDGE_IN_CALLER_PRIMARY}`);
  }

  // Secondary: OpType 2 = SetBridgeInCaller
  if (BRIDGE_IN_CALLER_SECONDARY && ethers.isAddress(BRIDGE_IN_CALLER_SECONDARY)) {
    const currentSecondaryCaller = await liberdusSecondary.bridgeInCaller();
    if (currentSecondaryCaller.toLowerCase() === BRIDGE_IN_CALLER_SECONDARY.toLowerCase()) {
      console.log(`Secondary BridgeInCaller already set to ${BRIDGE_IN_CALLER_SECONDARY}, skipping.`);
    } else {
      console.log(`--- Setting BridgeInCaller on Secondary to ${BRIDGE_IN_CALLER_SECONDARY} ---`);
      await requestAndSignOperation(liberdusSecondary, OP_TYPES.SECONDARY.SET_BRIDGE_IN_CALLER, BRIDGE_IN_CALLER_SECONDARY, 0, "0x");
      console.log("  Done.");
    }
  } else if (BRIDGE_IN_CALLER_SECONDARY) {
    console.log(`\nWarning: Invalid BRIDGE_IN_CALLER_SECONDARY address: ${BRIDGE_IN_CALLER_SECONDARY}`);
  }

  // Secondary bridge direction flags (optional)
  const desiredBridgeInEnabled = parseOptionalBoolean(SECONDARY_BRIDGE_IN_ENABLED, "SECONDARY_BRIDGE_IN_ENABLED");
  if (desiredBridgeInEnabled !== null) {
    const currentBridgeInEnabled = await liberdusSecondary.bridgeInEnabled();
    if (currentBridgeInEnabled === desiredBridgeInEnabled) {
      console.log(`Secondary bridgeInEnabled already ${desiredBridgeInEnabled}, skipping.`);
    } else {
      console.log(`--- Setting Secondary bridgeInEnabled to ${desiredBridgeInEnabled} ---`);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [desiredBridgeInEnabled]);
      await requestAndSignOperation(liberdusSecondary, OP_TYPES.SECONDARY.SET_BRIDGE_IN_ENABLED, ethers.ZeroAddress, 0, data);
      console.log("  Done.");
    }
  }

  const desiredBridgeOutEnabled = parseOptionalBoolean(SECONDARY_BRIDGE_OUT_ENABLED, "SECONDARY_BRIDGE_OUT_ENABLED");
  if (desiredBridgeOutEnabled !== null) {
    const currentBridgeOutEnabled = await liberdusSecondary.bridgeOutEnabled();
    if (currentBridgeOutEnabled === desiredBridgeOutEnabled) {
      console.log(`Secondary bridgeOutEnabled already ${desiredBridgeOutEnabled}, skipping.`);
    } else {
      console.log(`--- Setting Secondary bridgeOutEnabled to ${desiredBridgeOutEnabled} ---`);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [desiredBridgeOutEnabled]);
      await requestAndSignOperation(liberdusSecondary, OP_TYPES.SECONDARY.SET_BRIDGE_OUT_ENABLED, ethers.ZeroAddress, 0, data);
      console.log("  Done.");
    }
  }

  if (SECONDARY_MIN_BRIDGE_OUT_AMOUNT) {
    const newMin = ethers.parseUnits(SECONDARY_MIN_BRIDGE_OUT_AMOUNT, 18);
    const currentMin = await liberdusSecondary.minBridgeOutAmount();
    if (currentMin === newMin) {
      console.log(`Secondary minBridgeOutAmount already ${SECONDARY_MIN_BRIDGE_OUT_AMOUNT} LIB, skipping.`);
    } else {
      console.log(`--- Setting Secondary minBridgeOutAmount to ${SECONDARY_MIN_BRIDGE_OUT_AMOUNT} LIB ---`);
      await requestAndSignOperation(liberdusSecondary, OP_TYPES.SECONDARY.SET_MIN_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, newMin, "0x");
      console.log("  Done.");
    }
  }

  // Vault: bridgeOutEnabled control
  if (!VAULT_ADDR) {
    console.log("\nVault address not provided (VAULT_ADDRESS). Skipping Vault setup.");
  } else if (!vault) {
    console.log(`\nWarning: Invalid VAULT_ADDRESS: ${VAULT_ADDR}`);
  }

  const desiredVaultBridgeOutEnabled = parseOptionalBoolean(VAULT_BRIDGE_OUT_ENABLED, "VAULT_BRIDGE_OUT_ENABLED");
  if (!VAULT_ADDR) {
    if (desiredVaultBridgeOutEnabled !== null) {
      console.log("\nVault address not provided (VAULT_ADDRESS). Skipping Vault bridgeOutEnabled setup.");
    }
  } else if (!vault) {
    if (desiredVaultBridgeOutEnabled !== null) {
      console.log(`\nWarning: Invalid VAULT_ADDRESS: ${VAULT_ADDR}`);
    }
  } else if (desiredVaultBridgeOutEnabled !== null) {
    const currentVaultBridgeOutEnabled = await vault.bridgeOutEnabled();
    if (currentVaultBridgeOutEnabled === desiredVaultBridgeOutEnabled) {
      console.log(`Vault bridgeOutEnabled already ${desiredVaultBridgeOutEnabled}, skipping.`);
    } else {
      console.log(`--- Setting Vault bridgeOutEnabled to ${desiredVaultBridgeOutEnabled} ---`);
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [desiredVaultBridgeOutEnabled]);
      await requestAndSignOperation(vault, OP_TYPES.VAULT.SET_BRIDGE_OUT_ENABLED, ethers.ZeroAddress, 0, data);
      console.log("  Done.");
    }
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
        await requestAndSignOperation(liberdus, OP_TYPES.PRIMARY.DISTRIBUTE_TOKENS, recipient, tokenAmount, "0x");
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
