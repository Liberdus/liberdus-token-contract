const hre = require("hardhat");
const { ZeroAddress } = require("hardhat").ethers;
const { ethers } = hre;

// Flag to control whether to notify the coordinator after a successful bridge out
const NOTIFY_COORDINATOR = process.env.NOTIFY_COORDINATOR === "true" || false;

const PRIMARY_OP = Object.freeze({
  MINT: 0,
  POST_LAUNCH: 2,
  SET_BRIDGE_IN_CALLER: 5,
  DISTRIBUTE_TOKENS: 8,
});
const SECONDARY_OP = Object.freeze({
  SET_BRIDGE_IN_CALLER: 0,
  SET_BRIDGE_OUT_ENABLED: 4,
});

async function main() {
  const [deployer, signer1, signer2, signer3] = await hre.ethers.getSigners();

  console.log("Deploying contracts with the account:", deployer.address);
  console.log(
    "Account balance:",
    (await deployer.provider.getBalance(deployer.address)).toString(),
  );


  // --- CONFIGURATION ---
  // Simulate two chains
  const CHAIN_ID_PRIMARY = 31337;
  const CHAIN_ID_SECONDARY = 31338;

  let signerAddresses;
  let signers;

  if (hre.network.name === "hardhat" || hre.network.name === "localhost") {
    signerAddresses = [
      deployer.address,
      signer1.address,
      signer2.address,
      signer3.address,
    ];
    signers = [deployer, signer1, signer2, signer3];
  } else {
    // For non-local, just use configured signers (simplified for this script's scope)
    signers = hre.config.namedAccounts.signers[hre.network.name];
    signerAddresses = signers; // Assuming these are addresses
  }

  // --- HELPER FUNCTION ---
  async function requestAndSignOperation(contract, operationType, target, value, data) {
    const tx = await contract.requestOperation(
      operationType,
      target,
      value,
      data,
    );
    const receipt = await tx.wait();

    const operationRequestedEvent = receipt.logs.find(
      (log) => log.fragment.name === "OperationRequested",
    );
    const operationId = operationRequestedEvent.args.operationId;

    // Sign with 3 signers
    for (let i = 0; i < 3; i++) {
      const messageHash = await contract.getOperationHash(operationId);
      const signature = await signers[i].signMessage(
        ethers.getBytes(messageHash),
      );
      await contract
        .connect(signers[i])
        .submitSignature(operationId, signature);
    }
    return operationId;
  }

  async function ensureBridgeInCooldown(contract, label) {
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

  async function notifyCoordinator(chainId) {
    if (!NOTIFY_COORDINATOR) return;
    try {
      const coordinatorUrl = process.env.COORDINATOR_URL || "http://127.0.0.1:8000";
      console.log(`Notifying coordinator at ${coordinatorUrl} for chain ${chainId}...`);
      const response = await fetch(`${coordinatorUrl}/notify-bridgeout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chainId: Number(chainId) }),
      });
      if (!response.ok) {
        console.warn(`Coordinator returned status ${response.status}`);
      } else {
        const data = await response.json();
        console.log("Coordinator response:", data);
      }
    } catch (err) {
      console.error("Failed to notify coordinator:", err.message);
    }
  }

  // ====================================================
  // 1. DEPLOY LIBERDUS (PRIMARY)
  // ====================================================
  console.log("\n--- Deploying Liberdus (Primary Chain: 31337) ---");
  const LiberdusToken = await hre.ethers.getContractFactory("Liberdus");
  const liberdus = await LiberdusToken.deploy(signerAddresses, CHAIN_ID_PRIMARY);
  await liberdus.waitForDeployment();
  console.log(`Liberdus deployed to: ${await liberdus.getAddress()}`);

  // ====================================================
  // 2. DEPLOY VAULT (PRIMARY CHAIN LOCKER)
  // ====================================================
  console.log("\n--- Deploying Vault (Primary Chain: 31337) ---");
  const Vault = await hre.ethers.getContractFactory("Vault");
  const vault = await Vault.deploy(await liberdus.getAddress(), signerAddresses, CHAIN_ID_PRIMARY);
  await vault.waitForDeployment();
  console.log(`Vault deployed to: ${await vault.getAddress()}`);

  // ====================================================
  // 3. DEPLOY LIBERDUS SECONDARY (SECONDARY)
  // ====================================================
  console.log("\n--- Deploying LiberdusSecondary (Secondary Chain: 31338) ---");
  const LiberdusSecondaryToken = await hre.ethers.getContractFactory("LiberdusSecondary");
  const liberdusSecondary = await LiberdusSecondaryToken.deploy(signerAddresses, CHAIN_ID_SECONDARY);
  await liberdusSecondary.waitForDeployment();
  console.log(`LiberdusSecondary deployed to: ${await liberdusSecondary.getAddress()}`);


  // ====================================================
  // 4. SETUP PRIMARY CHAIN (PRE-LAUNCH)
  // ====================================================
  console.log("\n--- Setting up Liberdus (Primary) ---");

  // Mint (OpType 0)
  console.log("Minting tokens...");
  await requestAndSignOperation(liberdus, PRIMARY_OP.MINT, deployer.address, 0, "0x");

  // Distribute (OpType 8)
  console.log("Distributing 500000 tokens to deployer...");
  const distributionAmount = ethers.parseUnits("500000", 18);
  await requestAndSignOperation(liberdus, PRIMARY_OP.DISTRIBUTE_TOKENS, deployer.address, distributionAmount, "0x");

  // Set BridgeInCaller (OpType 5) - allowing deployer to act as bridge for testing
  console.log("Setting BridgeInCaller to deployer...");
  await requestAndSignOperation(liberdus, PRIMARY_OP.SET_BRIDGE_IN_CALLER, deployer.address, 0, "0x");


  // ====================================================
  // 5. SETUP SECONDARY CHAIN
  // ====================================================
  console.log("\n--- Setting up LiberdusSecondary ---");

  // Set BridgeInCaller (OpType 2) - allowing deployer to act as bridge
  console.log("Setting Secondary BridgeInCaller to deployer...");
  await requestAndSignOperation(
    liberdusSecondary,
    SECONDARY_OP.SET_BRIDGE_IN_CALLER,
    deployer.address,
    0,
    "0x"
  );

  // ====================================================
  // 6. INTERACTION: BRIDGE OUT (Vault -> Secondary)
  // ====================================================
  console.log("\n--- Interaction: Bridge Out (Vault -> Secondary) ---");
  const bridgeAmount = ethers.parseUnits("10000", 18);

  console.log(`Approving Vault for ${ethers.formatUnits(bridgeAmount, 18)} LIB on Primary...`);
  await liberdus.connect(deployer).approve(await vault.getAddress(), bridgeAmount);

  console.log(`Bridging out ${ethers.formatUnits(bridgeAmount, 18)} LIB via Vault...`);
  const vaultBridgeOutTx = await vault.connect(deployer).bridgeOut(bridgeAmount, deployer.address, CHAIN_ID_PRIMARY);
  const vaultBridgeOutReceipt = await vaultBridgeOutTx.wait();
  await notifyCoordinator(CHAIN_ID_PRIMARY);

  console.log("Primary Balance:", ethers.formatUnits(await liberdus.balanceOf(deployer.address), 18));
  console.log("Vault Balance:", ethers.formatUnits(await vault.getVaultBalance(), 18));

  // Simulate Relayer: Bridge In on Secondary
  console.log(`Bridging in ${ethers.formatUnits(bridgeAmount, 18)} LIB to Secondary...`);
  await ensureBridgeInCooldown(liberdusSecondary, "Secondary");
  await liberdusSecondary.connect(deployer).bridgeIn(deployer.address, bridgeAmount, CHAIN_ID_SECONDARY, vaultBridgeOutReceipt.hash);

  console.log("Secondary Balance:", ethers.formatUnits(await liberdusSecondary.balanceOf(deployer.address), 18));


  // ====================================================
  // 7. SWITCH PRIMARY TO POST-LAUNCH AND ENABLE SECONDARY BRIDGE OUT
  // ====================================================
  console.log("\n--- Switching Primary to Post-Launch and Enabling Secondary BridgeOut ---");

  // Switch Primary to Post-Launch
  console.log("Switching Primary to Post-Launch...");
  await requestAndSignOperation(liberdus, PRIMARY_OP.POST_LAUNCH, ZeroAddress, 0, "0x");

  // Enable Secondary BridgeOut
  console.log("Enabling Secondary bridgeOut...");
  const enableBridgeOutData = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]);
  await requestAndSignOperation(
    liberdusSecondary,
    SECONDARY_OP.SET_BRIDGE_OUT_ENABLED,
    ZeroAddress,
    0,
    enableBridgeOutData
  );

  // ====================================================
  // 8. INTERACTION: BRIDGING (Primary <-> Secondary)
  // ====================================================
  console.log("\n--- Interaction: Bridging (Primary <-> Secondary) ---");


  // A. Primary -> Secondary (Burn -> Mint)
  const p2sBridgeAmount = ethers.parseUnits("500", 18);
  console.log(`\n[Primary -> Secondary] Bridging out ${ethers.formatUnits(p2sBridgeAmount, 18)} LIB from Primary...`);
  const p2sBridgeOutTx = await liberdus.connect(deployer).bridgeOut(p2sBridgeAmount, deployer.address, CHAIN_ID_PRIMARY);
  const p2sBridgeOutReceipt = await p2sBridgeOutTx.wait();
  await notifyCoordinator(CHAIN_ID_PRIMARY);
  console.log("Primary Balance:", ethers.formatUnits(await liberdus.balanceOf(deployer.address), 18));

  console.log(`[Primary -> Secondary] Bridging in ${ethers.formatUnits(p2sBridgeAmount, 18)} LIB to Secondary...`);
  await ensureBridgeInCooldown(liberdusSecondary, "Secondary");
  await liberdusSecondary.connect(deployer).bridgeIn(deployer.address, p2sBridgeAmount, CHAIN_ID_SECONDARY, p2sBridgeOutReceipt.hash);
  console.log("Secondary Balance:", ethers.formatUnits(await liberdusSecondary.balanceOf(deployer.address), 18));

  // B. Secondary -> Primary (Burn -> Mint)
  const s2pBridgeAmount = ethers.parseUnits("200", 18);
  console.log(`\n[Secondary -> Primary] Bridging out ${ethers.formatUnits(s2pBridgeAmount, 18)} LIB from Secondary...`);
  const s2pBridgeOutTx = await liberdusSecondary.connect(deployer).bridgeOut(s2pBridgeAmount, deployer.address, CHAIN_ID_SECONDARY);
  const s2pBridgeOutReceipt = await s2pBridgeOutTx.wait();
  await notifyCoordinator(CHAIN_ID_SECONDARY);
  console.log("Secondary Balance:", ethers.formatUnits(await liberdusSecondary.balanceOf(deployer.address), 18));

  console.log(`[Secondary -> Primary] Bridging in ${ethers.formatUnits(s2pBridgeAmount, 18)} LIB to Primary...`);
  await ensureBridgeInCooldown(liberdus, "Primary");
  await liberdus.connect(deployer).bridgeIn(deployer.address, s2pBridgeAmount, CHAIN_ID_PRIMARY, s2pBridgeOutReceipt.hash);
  console.log("Primary Balance:", ethers.formatUnits(await liberdus.balanceOf(deployer.address), 18));

  console.log("\n--- Deployment Summary ---");
  console.log(`LIBERDUS_TOKEN_ADDRESS=${await liberdus.getAddress()}`);
  console.log(`VAULT_ADDRESS=${await vault.getAddress()}`);
  console.log(`LIBERDUS_SECONDARY_ADDRESS=${await liberdusSecondary.getAddress()}`);
  console.log("\n--- DONE ---");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
