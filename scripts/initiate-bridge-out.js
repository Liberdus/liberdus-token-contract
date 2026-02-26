const hre = require("hardhat");
const { ethers } = hre;

// Flag to control whether to notify the coordinator after a successful bridge out
const NOTIFY_COORDINATOR = process.env.NOTIFY_COORDINATOR === "true" || false;

async function main() {
  const CONTRACT_TYPE = (process.env.CONTRACT_TYPE || "SECONDARY").toUpperCase();
  let CONTRACT_ADDRESS;
  let CONTRACT_NAME;

  if (CONTRACT_TYPE === "PRIMARY") {
    CONTRACT_ADDRESS = process.env.LIBERDUS_TOKEN_ADDRESS;
    CONTRACT_NAME = "Liberdus";
  } else if (CONTRACT_TYPE === "VAULT") {
    CONTRACT_ADDRESS = process.env.VAULT_ADDRESS;
    CONTRACT_NAME = "Vault";
  } else {
    CONTRACT_ADDRESS = process.env.LIBERDUS_SECONDARY_ADDRESS;
    CONTRACT_NAME = "LiberdusSecondary";
  }

  if (!CONTRACT_ADDRESS) {
    if (CONTRACT_TYPE === "PRIMARY") {
      throw new Error("Set LIBERDUS_TOKEN_ADDRESS in your .env file");
    }
    if (CONTRACT_TYPE === "VAULT") {
      throw new Error("Set VAULT_ADDRESS in your .env file");
    }
    throw new Error("Set LIBERDUS_SECONDARY_ADDRESS in your .env file");
  }

  const [deployer] = await hre.ethers.getSigners();
  const chainId = (await hre.ethers.provider.getNetwork()).chainId;
  const amount = ethers.parseUnits(process.env.AMOUNT_LIB || "100", 18);
  const targetAddress = process.env.TARGET_ADDRESS || deployer.address;

  console.log("Using account:", deployer.address);
  console.log("Chain ID:", Number(chainId));
  console.log("Contract Type:", CONTRACT_TYPE);
  console.log("Contract Address:", CONTRACT_ADDRESS);

  // Attach to deployed contract
  const contract = await hre.ethers.getContractAt(CONTRACT_NAME, CONTRACT_ADDRESS);

  // Verify state (only primary contract has isPreLaunch)
  if (CONTRACT_TYPE === "PRIMARY") {
    const isPreLaunch = await contract.isPreLaunch();
    console.log("isPreLaunch:", isPreLaunch);
    if (isPreLaunch) {
      throw new Error("Contract is still in pre-launch mode. Bridge out not available.");
    }
  } else if (CONTRACT_TYPE === "SECONDARY") {
    const bridgeOutEnabled = await contract.bridgeOutEnabled();
    console.log("bridgeOutEnabled:", bridgeOutEnabled);
    if (!bridgeOutEnabled) {
      throw new Error("Secondary bridgeOut is disabled. Enable it via multisig first.");
    }
  } else if (CONTRACT_TYPE === "VAULT") {
    const bridgeOutEnabled = await contract.bridgeOutEnabled();
    console.log("bridgeOutEnabled:", bridgeOutEnabled);
    if (!bridgeOutEnabled) {
      throw new Error("Vault bridgeOut is disabled. Enable it via multisig first.");
    }
  }

  let tokenContract = null;
  let balance;
  if (CONTRACT_TYPE === "VAULT") {
    const tokenAddress = await contract.token();
    tokenContract = new ethers.Contract(
      tokenAddress,
      [
        "function balanceOf(address) view returns (uint256)",
        "function allowance(address,address) view returns (uint256)",
        "function approve(address,uint256) returns (bool)",
      ],
      deployer
    );
    balance = await tokenContract.balanceOf(deployer.address);
    console.log("Token Address:", tokenAddress);
  } else {
    balance = await contract.balanceOf(deployer.address);
  }

  console.log("Current Balance:", ethers.formatUnits(balance, 18), "LIB");
  if (balance < amount) {
    throw new Error(`Insufficient balance to bridge out. Have ${ethers.formatUnits(balance, 18)}, need ${ethers.formatUnits(amount, 18)}`);
  }

  console.log(`\nBridging out ${ethers.formatUnits(amount, 18)} LIB to ${targetAddress} on destination chain...`);
  
  let tx;
  if (CONTRACT_TYPE === "PRIMARY") {
    tx = await contract.bridgeOut(amount, targetAddress, chainId);
  } else {
    if (CONTRACT_TYPE === "VAULT") {
      const allowance = await tokenContract.allowance(deployer.address, CONTRACT_ADDRESS);
      if (allowance < amount) {
        console.log(`Approving Vault for ${ethers.formatUnits(amount, 18)} LIB...`);
        const approveTx = await tokenContract.approve(CONTRACT_ADDRESS, amount);
        await approveTx.wait();
      }
    }
    tx = await contract.bridgeOut(amount, targetAddress, chainId);
  }

  const receipt = await tx.wait();
  console.log("Transaction hash:", receipt.hash);

  if (NOTIFY_COORDINATOR) {
    try {
      const coordinatorUrl = process.env.COORDINATOR_URL || "http://127.0.0.1:8000";
      console.log(`Notifying coordinator at ${coordinatorUrl}...`);
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

  const newBalance = CONTRACT_TYPE === "VAULT"
    ? await tokenContract.balanceOf(deployer.address)
    : await contract.balanceOf(deployer.address);
  console.log("New Balance:", ethers.formatUnits(newBalance, 18), "LIB");
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
