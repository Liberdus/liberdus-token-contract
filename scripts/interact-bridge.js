const hre = require("hardhat");
const { ethers } = hre;

async function main() {
  const [deployer, signer1, signer2, signer3] = await hre.ethers.getSigners();

  // --- CONFIGURATION ---
  const LIBERDUS_ADDR = process.env.LIBERDUS_TOKEN_ADDRESS || "";
  const LIBERDUS_SEC_ADDR = process.env.LIBERDUS_SECONDARY_ADDRESS || "";
  const VAULT_ADDR = process.env.VAULT_ADDRESS || "";
  const BRIDGE_IN_CALLER_PRIMARY = process.env.BRIDGE_IN_CALLER_PRIMARY || "";
  const BRIDGE_IN_CALLER_SECONDARY = process.env.BRIDGE_IN_CALLER_SECONDARY || "";

  if (!LIBERDUS_ADDR || !LIBERDUS_SEC_ADDR || !VAULT_ADDR) {
    throw new Error("Set LIBERDUS_TOKEN_ADDRESS, LIBERDUS_SECONDARY_ADDRESS, and VAULT_ADDRESS in .env");
  }

  // --- CONFIGURATION ---
  // Simulate two chains
  const CHAIN_ID_PRIMARY = 31337;
  const CHAIN_ID_SECONDARY = 31338;

  const balanceOnly = process.env.BALANCE_ONLY === "true" || process.env.BALANCE_ONLY === "1";
  const bridgeAction = (process.env.BRIDGE_ACTION || "bridgeout").toLowerCase();

  if (!["bridgeout", "bridgein", "bridgeboth"].includes(bridgeAction)) {
    throw new Error("BRIDGE_ACTION must be bridgeOut, bridgeIn, or bridgeBoth");
  }
  const doBridgeOut = bridgeAction === "bridgeout" || bridgeAction === "bridgeboth";
  const doBridgeIn = bridgeAction === "bridgein" || bridgeAction === "bridgeboth";

  console.log("Interacting with contracts...");
  console.log("Deployer:", deployer.address);
  console.log("Signer 1:", signer1.address);
  console.log("Signer 2:", signer2.address);
  console.log("Signer 3:", signer3.address);
  console.log("Bridge Action:", bridgeAction);

  // Attach to contracts
  const Liberdus = await ethers.getContractFactory("Liberdus");
  const liberdus = Liberdus.attach(LIBERDUS_ADDR);

  const LiberdusSecondary = await ethers.getContractFactory("LiberdusSecondary");
  const liberdusSecondary = LiberdusSecondary.attach(LIBERDUS_SEC_ADDR);

  const Vault = await ethers.getContractFactory("Vault");
  const vault = Vault.attach(VAULT_ADDR);

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
  console.log(`Vault Locked Balance: ${ethers.formatUnits(await vault.getVaultBalance(), 18)} LIB`);

  if (balanceOnly) {
    console.log("\n--- Balance check complete ---");
    return;
  }

  function buildTxId(routeName) {
    return ethers.id(`${routeName}-${Date.now()}-${Math.floor(Math.random() * 1_000_000)}`);
  }

  async function ensureBridgeInReady(contract, label) {
    if (label === "Primary") {
      const isPreLaunch = await contract.isPreLaunch();
      if (isPreLaunch) {
        throw new Error("Primary is in pre-launch; bridgeIn is not available.");
      }
    } else {
      const bridgeInEnabled = await contract.bridgeInEnabled();
      if (!bridgeInEnabled) {
        throw new Error("Secondary bridgeIn is disabled.");
      }
    }

    const lastBridgeInTime = await contract.lastBridgeInTime();
    const bridgeInCooldown = await contract.bridgeInCooldown();
    const now = BigInt(Math.floor(Date.now() / 1000));
    const nextAllowedAt = lastBridgeInTime + bridgeInCooldown;

    if (now < nextAllowedAt) {
      const waitSeconds = Number(nextAllowedAt - now);
      if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
        console.log(`${label} bridgeIn cooldown active (${waitSeconds}s). Advancing local time...`);
        await hre.ethers.provider.send("evm_increaseTime", [waitSeconds + 1]);
        await hre.ethers.provider.send("evm_mine");
      } else {
        throw new Error(`${label} bridgeIn cooldown not met. Wait ${waitSeconds}s and retry.`);
      }
    }
  }

  async function resolveBridgeInSigner(contract, label, envBridgeInCaller) {
    const bridgeInCaller = await contract.bridgeInCaller();
    if (
      envBridgeInCaller
      && bridgeInCaller.toLowerCase() !== envBridgeInCaller.toLowerCase()
    ) {
      console.warn(
        `[WARN] ${label} bridgeInCaller mismatch: env=${envBridgeInCaller}, onchain=${bridgeInCaller}`,
      );
      return { signer: null, shouldSkip: true };
    }

    let signer = deployer;
    if (envBridgeInCaller) {
      try {
        signer = await hre.ethers.getSigner(envBridgeInCaller);
        const managedAccounts = await hre.ethers.provider.send("eth_accounts", []);
        const isManaged = managedAccounts.some(
          (a) => String(a).toLowerCase() === signer.address.toLowerCase(),
        );
        if (!isManaged) {
          console.warn(
            `[WARN] ${label} env bridgeIn caller ${envBridgeInCaller} is not managed by this node. Skipping bridgeIn for ${label}.`,
          );
          return { signer: null, shouldSkip: true };
        }
      } catch (error) {
        console.warn(
          `[WARN] Could not resolve local signer for ${label} env bridgeIn caller ${envBridgeInCaller}. Skipping bridgeIn for ${label}.`,
        );
        return { signer: null, shouldSkip: true };
      }
    }

    if (signer.address.toLowerCase() !== bridgeInCaller.toLowerCase()) {
      console.warn(
        `[WARN] ${label} bridgeIn caller mismatch: tx signer=${signer.address}, onchain=${bridgeInCaller}. Skipping bridgeIn for ${label}.`,
      );
      return { signer: null, shouldSkip: true };
    }

    return { signer, shouldSkip: false };
  }

  // ====================================================
  // PRIMARY -> SECONDARY (via Vault)
  // ====================================================
  console.log("\n--- Primary -> Secondary (via Vault) ---");
  const vaultToSecondaryAmount = ethers.parseUnits(process.env.STEP1_AMOUNT || process.env.BRIDGE_OUT_AMOUNT || "5", 18);

  let vaultBridgeOutDone = !doBridgeOut;
  let vaultBridgeOutTxId = null;
  if (doBridgeOut) {
    const signer1PrimaryBal = await liberdus.balanceOf(signer1.address);
    console.log(`Signer 1 Primary Balance: ${ethers.formatUnits(signer1PrimaryBal, 18)} LIB`);
    if (signer1PrimaryBal >= vaultToSecondaryAmount) {
      const approveTx = await liberdus.connect(signer1).approve(VAULT_ADDR, vaultToSecondaryAmount);
      await approveTx.wait();

      const tx = await vault.connect(signer1).bridgeOut(vaultToSecondaryAmount, signer1.address, CHAIN_ID_PRIMARY);
      const receipt = await tx.wait();
      vaultBridgeOutDone = true;
      vaultBridgeOutTxId = receipt.hash;
      console.log("Vault bridgeOut successful.");
      console.log(`Signer 1 Primary Remaining: ${ethers.formatUnits(await liberdus.balanceOf(signer1.address), 18)} LIB`);
      console.log(`Vault Locked Balance: ${ethers.formatUnits(await vault.getVaultBalance(), 18)} LIB`);
    } else {
      console.log(`Skipping Vault bridgeOut: signer1 needs at least ${ethers.formatUnits(vaultToSecondaryAmount, 18)} LIB.`);
    }
  }
  if (doBridgeIn) {
    if (!vaultBridgeOutDone) {
      console.log("Skipping Secondary bridgeIn: Vault bridgeOut did not complete.");
    } else {
      await ensureBridgeInReady(liberdusSecondary, "Secondary");
      const { signer: secondaryBridgeSigner, shouldSkip } = await resolveBridgeInSigner(
        liberdusSecondary,
        "Secondary",
        BRIDGE_IN_CALLER_SECONDARY,
      );
      if (shouldSkip) {
        console.log("Skipping Secondary bridgeIn due to bridgeInCaller mismatch.");
      } else {
        const txId = bridgeAction === "bridgeboth" && vaultBridgeOutTxId ? vaultBridgeOutTxId : buildTxId("vault-p2s");
        const tx = await liberdusSecondary.connect(secondaryBridgeSigner).bridgeIn(signer1.address, vaultToSecondaryAmount, CHAIN_ID_SECONDARY, txId);
        await tx.wait();
        console.log("Secondary bridgeIn successful.");
        console.log(`Signer 1 Secondary Balance: ${ethers.formatUnits(await liberdusSecondary.balanceOf(signer1.address), 18)} LIB`);
      }
    }
  }

  // ====================================================
  // PRIMARY -> SECONDARY (direct token bridge)
  // ====================================================
  console.log("\n--- Primary -> Secondary (direct) ---");
  const primaryToSecondaryAmount = ethers.parseUnits(process.env.STEP2_AMOUNT || "2", 18);

  let primaryBridgeOutDone = !doBridgeOut;
  let primaryBridgeOutTxId = null;
  if (doBridgeOut) {
    const signer2PrimaryBal = await liberdus.balanceOf(signer2.address);
    console.log(`Signer 2 Primary Balance: ${ethers.formatUnits(signer2PrimaryBal, 18)} LIB`);
    if (signer2PrimaryBal >= primaryToSecondaryAmount) {
      const tx = await liberdus.connect(signer2).bridgeOut(primaryToSecondaryAmount, signer2.address, CHAIN_ID_PRIMARY);
      const receipt = await tx.wait();
      primaryBridgeOutDone = true;
      primaryBridgeOutTxId = receipt.hash;
      console.log("Primary bridgeOut successful.");
      console.log(`Signer 2 Primary Remaining: ${ethers.formatUnits(await liberdus.balanceOf(signer2.address), 18)} LIB`);
    } else {
      console.log(`Skipping Primary bridgeOut: signer2 needs at least ${ethers.formatUnits(primaryToSecondaryAmount, 18)} LIB.`);
    }
  }
  if (doBridgeIn) {
    if (!primaryBridgeOutDone) {
      console.log("Skipping Secondary bridgeIn: Primary bridgeOut did not complete.");
    } else {
      await ensureBridgeInReady(liberdusSecondary, "Secondary");
      const { signer: secondaryBridgeSigner, shouldSkip } = await resolveBridgeInSigner(
        liberdusSecondary,
        "Secondary",
        BRIDGE_IN_CALLER_SECONDARY,
      );
      if (shouldSkip) {
        console.log("Skipping Secondary bridgeIn due to bridgeInCaller mismatch.");
      } else {
        const txId = bridgeAction === "bridgeboth" && primaryBridgeOutTxId ? primaryBridgeOutTxId : buildTxId("primary-p2s");
        const tx = await liberdusSecondary.connect(secondaryBridgeSigner).bridgeIn(signer2.address, primaryToSecondaryAmount, CHAIN_ID_SECONDARY, txId);
        await tx.wait();
        console.log("Secondary bridgeIn successful.");
        console.log(`Signer 2 Secondary Balance: ${ethers.formatUnits(await liberdusSecondary.balanceOf(signer2.address), 18)} LIB`);
      }
    }
  }

  // ====================================================
  // SECONDARY -> PRIMARY (direct token bridge)
  // ====================================================
  console.log("\n--- Secondary -> Primary (direct) ---");
  const secondaryToPrimaryAmount = ethers.parseUnits(process.env.STEP3_AMOUNT || process.env.BRIDGE_BACK_AMOUNT || "1", 18);

  let secondaryBridgeOutDone = !doBridgeOut;
  let secondaryBridgeOutTxId = null;
  if (doBridgeOut) {
    const signer3SecondaryBal = await liberdusSecondary.balanceOf(signer3.address);
    const secondaryBridgeOutEnabled = await liberdusSecondary.bridgeOutEnabled();
    console.log(`Secondary bridgeOutEnabled: ${secondaryBridgeOutEnabled}`);
    console.log(`Signer 3 Secondary Balance: ${ethers.formatUnits(signer3SecondaryBal, 18)} LIB`);

    if (!secondaryBridgeOutEnabled) {
      console.log("Skipping Secondary bridgeOut: bridgeOut is disabled.");
    } else if (signer3SecondaryBal >= secondaryToPrimaryAmount) {
      const outTx = await liberdusSecondary.connect(signer3).bridgeOut(secondaryToPrimaryAmount, signer3.address, CHAIN_ID_SECONDARY);
      const receipt = await outTx.wait();
      secondaryBridgeOutDone = true;
      secondaryBridgeOutTxId = receipt.hash;
      console.log("Secondary bridgeOut successful.");
      console.log(`Signer 3 Secondary Remaining: ${ethers.formatUnits(await liberdusSecondary.balanceOf(signer3.address), 18)} LIB`);
    } else {
      console.log(`Skipping Secondary bridgeOut: signer3 needs at least ${ethers.formatUnits(secondaryToPrimaryAmount, 18)} LIB.`);
    }
  }
  if (doBridgeIn) {
    if (!secondaryBridgeOutDone) {
      console.log("Skipping Primary bridgeIn: Secondary bridgeOut did not complete.");
    } else {
      await ensureBridgeInReady(liberdus, "Primary");
      const { signer: primaryBridgeSigner, shouldSkip } = await resolveBridgeInSigner(
        liberdus,
        "Primary",
        BRIDGE_IN_CALLER_PRIMARY,
      );
      if (shouldSkip) {
        console.log("Skipping Primary bridgeIn due to bridgeInCaller mismatch.");
      } else {
        const txId = bridgeAction === "bridgeboth" && secondaryBridgeOutTxId ? secondaryBridgeOutTxId : buildTxId("secondary-s2p");
        const tx = await liberdus.connect(primaryBridgeSigner).bridgeIn(signer3.address, secondaryToPrimaryAmount, CHAIN_ID_PRIMARY, txId);
        await tx.wait();
        console.log("Primary bridgeIn successful.");
        console.log(`Signer 3 Primary Balance: ${ethers.formatUnits(await liberdus.balanceOf(signer3.address), 18)} LIB`);
      }
    }
  }

  console.log("\n--- Interaction Complete ---");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
