const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Vault", function () {
  let Liberdus;
  let liberdus;
  let Vault;
  let vault;
  let owner, signer1, signer2, signer3, signer4, recipient, other;
  let signers;
  let signerAddresses;
  let chainId;
  const OP = Object.freeze({
    SET_BRIDGE_OUT_AMOUNT: 0,
    UPDATE_SIGNER: 1,
    SET_BRIDGE_OUT_ENABLED: 2,
    RELINQUISH_TOKENS: 3,
  });

  async function requestAndSignOperation(contract, operationType, target, value, data) {
    const tx = await contract.requestOperation(operationType, target, value, data);
    const receipt = await tx.wait();

    const operationRequestedEvent = receipt.logs.find(log => log.fragment.name === 'OperationRequested');
    const operationId = operationRequestedEvent.args.operationId;

    for (let i = 0; i < 3; i++) {
      const messageHash = await contract.getOperationHash(operationId);
      const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
      await contract.connect(signers[i]).submitSignature(operationId, signature);
    }

    return operationId;
  }

  async function setupLiberdusWithTokens() {
    // Mint tokens via multisig (OpType 0 = Mint)
    await requestAndSignOperation(liberdus, 0, owner.address, 0, "0x");

    // Distribute tokens to owner (OpType 8 = DistributeTokens)
    const distributionAmount = ethers.parseUnits("100000", 18);
    await requestAndSignOperation(liberdus, 8, owner.address, distributionAmount, "0x");

    return distributionAmount;
  }

  beforeEach(async function () {
    [owner, signer1, signer2, signer3, signer4, recipient, other] = await ethers.getSigners();
    signers = [owner, signer1, signer2, signer3];
    signerAddresses = [owner.address, signer1.address, signer2.address, signer3.address];
    chainId = BigInt((await ethers.provider.getNetwork()).chainId);

    // Deploy Liberdus (primary token)
    Liberdus = await ethers.getContractFactory("Liberdus");
    liberdus = await Liberdus.deploy(signerAddresses, chainId);
    await liberdus.waitForDeployment();

    // Deploy Vault
    Vault = await ethers.getContractFactory("Vault");
    vault = await Vault.deploy(await liberdus.getAddress(), signerAddresses, chainId);
    await vault.waitForDeployment();
  });

  describe("Deployment", function () {
    it("Should deploy with correct token address", async function () {
      expect(await vault.token()).to.equal(await liberdus.getAddress());
    });

    it("Should deploy with correct signers", async function () {
      for (let i = 0; i < 4; i++) {
        expect(await vault.isSigner(signerAddresses[i])).to.be.true;
      }
    });

    it("Should have correct chainId", async function () {
      expect(await vault.getChainId()).to.equal(chainId);
    });

    it("Should initialize with bridgeOut enabled", async function () {
      expect(await vault.bridgeOutEnabled()).to.equal(true);
    });

    it("Should reject zero token address", async function () {
      await expect(
        Vault.deploy(ethers.ZeroAddress, signerAddresses, chainId)
      ).to.be.revertedWith("Invalid token address");
    });
  });

  describe("Bridge Out", function () {
    beforeEach(async function () {
      await setupLiberdusWithTokens();
    });

    it("Should bridge out tokens successfully", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);

      // Approve vault
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      // Bridge out tokens and check event
      await expect(vault.connect(owner).bridgeOut(bridgeAmount, recipient.address, chainId))
        .to.emit(vault, "BridgedOut");

      expect(await vault.getVaultBalance()).to.equal(bridgeAmount);
      expect(await liberdus.balanceOf(owner.address)).to.equal(ethers.parseUnits("99000", 18));
    });

    it("Should reject bridging out zero tokens", async function () {
      await expect(
        vault.connect(owner).bridgeOut(0, recipient.address, chainId)
      ).to.be.revertedWith("Cannot bridge out zero tokens");
    });

    it("Should reject bridging out to zero address", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      await expect(
        vault.connect(owner).bridgeOut(bridgeAmount, ethers.ZeroAddress, chainId)
      ).to.be.revertedWith("Invalid target address");
    });

    it("Should reject bridging out without approval", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);

      await expect(
        vault.connect(owner).bridgeOut(bridgeAmount, recipient.address, chainId)
      ).to.be.reverted;
    });

    it("Should reject bridging out with insufficient balance", async function () {
      const elevatedLimit = ethers.parseUnits("300000", 18);
      await requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, elevatedLimit, "0x");

      const tooMuch = ethers.parseUnits("200000", 18); // More than the 100k minted
      await liberdus.connect(owner).approve(await vault.getAddress(), tooMuch);

      await expect(
        vault.connect(owner).bridgeOut(tooMuch, recipient.address, chainId)
      ).to.be.revertedWith("Insufficient balance");
    });

    it("Should reject bridging out more than maxBridgeOutAmount", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      const reducedMaxAmount = ethers.parseUnits("500", 18);
      await requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, reducedMaxAmount, "0x");

      await expect(
        vault.connect(owner).bridgeOut(bridgeAmount, recipient.address, chainId)
      ).to.be.revertedWith("Amount exceeds bridge-out limit");
    });

    it("Should reject bridging out when bridgeOut is disabled", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      const disabledData = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [false]);
      await requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_ENABLED, ethers.ZeroAddress, 0, disabledData);

      await expect(
        vault.connect(owner).bridgeOut(bridgeAmount, recipient.address, chainId)
      ).to.be.revertedWith("Bridge-out disabled");
    });

    it("Should disable and then re-enable bridgeOut via multisig", async function () {
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);

      const disabledData = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [false]);
      await requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_ENABLED, ethers.ZeroAddress, 0, disabledData);
      expect(await vault.bridgeOutEnabled()).to.equal(false);

      const enabledData = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]);
      await requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_ENABLED, ethers.ZeroAddress, 0, enabledData);
      expect(await vault.bridgeOutEnabled()).to.equal(true);

      await expect(
        vault.connect(owner).bridgeOut(bridgeAmount, recipient.address, chainId)
      ).to.emit(vault, "BridgedOut");
    });
  });

  describe("Relinquish Tokens", function () {
    const bridgeAmount = ethers.parseUnits("5000", 18);

    beforeEach(async function () {
      await setupLiberdusWithTokens();
      // Bridge out tokens first to fund the vault
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);
      await vault.connect(owner).bridgeOut(bridgeAmount, recipient.address, chainId);
    });

    it("Should relinquish all tokens to Liberdus contract via multisig", async function () {
      const vaultBalanceBefore = await vault.getVaultBalance();
      expect(vaultBalanceBefore).to.equal(bridgeAmount);

      const liberdusAddress = await liberdus.getAddress();
      const liberdusBalanceBefore = await liberdus.balanceOf(liberdusAddress);

      await requestAndSignOperation(vault, OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x");

      expect(await vault.getVaultBalance()).to.equal(0);
      expect(await liberdus.balanceOf(liberdusAddress)).to.equal(liberdusBalanceBefore + bridgeAmount);
    });

    it("Should emit TokensRelinquished event", async function () {
      const tx = await vault.requestOperation(OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Sign with first 2 signers
      for (let i = 0; i < 2; i++) {
        const messageHash = await vault.getOperationHash(operationId);
        const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
        await vault.connect(signers[i]).submitSignature(operationId, signature);
      }

      // Third signature triggers execution and emits both events
      const messageHash = await vault.getOperationHash(operationId);
      const signature = await signers[2].signMessage(ethers.getBytes(messageHash));
      await expect(vault.connect(signers[2]).submitSignature(operationId, signature))
        .to.emit(vault, "TokensRelinquished")
        .and.to.emit(vault, "VaultHalted");
    });

    it("Should set halted flag after relinquish", async function () {
      expect(await vault.halted()).to.equal(false);
      await requestAndSignOperation(vault, OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x");
      expect(await vault.halted()).to.equal(true);
    });

    it("Should block bridgeOut after relinquish", async function () {
      await requestAndSignOperation(vault, OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x");

      const bridgeAmount = ethers.parseUnits("100", 18);
      await expect(
        vault.connect(owner).bridgeOut(bridgeAmount, recipient.address, chainId)
      ).to.be.revertedWith("Vault is permanently halted");
    });

    it("Should block requestOperation after relinquish", async function () {
      await requestAndSignOperation(vault, OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x");

      await expect(
        vault.requestOperation(OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, ethers.parseUnits("20000", 18), "0x")
      ).to.be.revertedWith("Vault is permanently halted");
    });

    it("Should block submitSignature after relinquish", async function () {
      // Request an operation before relinquish
      const tx = await vault.requestOperation(OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, ethers.parseUnits("20000", 18), "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Relinquish and halt the vault
      await requestAndSignOperation(vault, OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x");

      // Try to submit a signature on the pre-existing operation
      const messageHash = await vault.getOperationHash(operationId);
      const signature = await signers[0].signMessage(ethers.getBytes(messageHash));
      await expect(
        vault.connect(signers[0]).submitSignature(operationId, signature)
      ).to.be.revertedWith("Vault is permanently halted");
    });
  });

  describe("Multi-sig Operations", function () {
    it("Should set bridge out amount via multisig", async function () {
      const newMaxAmount = ethers.parseUnits("20000", 18);
      await requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, newMaxAmount, "0x");
      expect(await vault.maxBridgeOutAmount()).to.equal(newMaxAmount);
    });

    it("Should reject relinquish when vault has no tokens", async function () {
      // Vault is not funded in this describe block's beforeEach
      await expect(
        requestAndSignOperation(vault, OP.RELINQUISH_TOKENS, ethers.ZeroAddress, 0, "0x")
      ).to.be.revertedWith("No tokens to relinquish");
    });

    it("Should update signer correctly", async function () {
      const newSigner = signer4;
      const oldSigner = signer3;

      const tx = await vault.requestOperation(OP.UPDATE_SIGNER, oldSigner.address, BigInt(newSigner.address), "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Sign with 3 signers (not the one being replaced)
      const signersToSign = signers.filter(s => s !== oldSigner).slice(0, 3);
      for (const signer of signersToSign) {
        const messageHash = await vault.getOperationHash(operationId);
        const signature = await signer.signMessage(ethers.getBytes(messageHash));
        await vault.connect(signer).submitSignature(operationId, signature);
      }

      expect(await vault.isSigner(newSigner.address)).to.be.true;
      expect(await vault.isSigner(oldSigner.address)).to.be.false;
    });

    it("Should allow owner (non-signer) to submit signature for UpdateSigner", async function () {
      // Deploy a vault where owner is NOT one of the signers
      const nonOwnerSignerAddresses = [signer1.address, signer2.address, signer3.address, signer4.address];
      const nonOwnerSigners = [signer1, signer2, signer3, signer4];
      const vaultNoOwner = await Vault.deploy(await liberdus.getAddress(), nonOwnerSignerAddresses, chainId);
      await vaultNoOwner.waitForDeployment();

      // Owner (non-signer) requests to replace signer4 with 'other'
      const tx = await vaultNoOwner.connect(owner).requestOperation(
        OP.UPDATE_SIGNER, signer4.address, BigInt(other.address), "0x"
      );
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Two registered signers submit first
      for (let i = 0; i < 2; i++) {
        const messageHash = await vaultNoOwner.getOperationHash(operationId);
        const sig = await nonOwnerSigners[i].signMessage(ethers.getBytes(messageHash));
        await vaultNoOwner.connect(nonOwnerSigners[i]).submitSignature(operationId, sig);
      }

      // Owner (non-signer) submits the 3rd signature — should succeed and execute
      const messageHash = await vaultNoOwner.getOperationHash(operationId);
      const ownerSig = await owner.signMessage(ethers.getBytes(messageHash));
      await expect(vaultNoOwner.connect(owner).submitSignature(operationId, ownerSig))
        .to.emit(vaultNoOwner, "OperationExecuted");

      expect(await vaultNoOwner.isSigner(other.address)).to.be.true;
      expect(await vaultNoOwner.isSigner(signer4.address)).to.be.false;
    });

    it("Should not allow owner (non-signer) to submit signature for non-UpdateSigner operations", async function () {
      // Deploy a vault where owner is NOT one of the signers
      const nonOwnerSignerAddresses = [signer1.address, signer2.address, signer3.address, signer4.address];
      const vaultNoOwner = await Vault.deploy(await liberdus.getAddress(), nonOwnerSignerAddresses, chainId);
      await vaultNoOwner.waitForDeployment();

      const newMaxAmount = ethers.parseUnits("20000", 18);
      const tx = await vaultNoOwner.connect(signer1).requestOperation(
        OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, newMaxAmount, "0x"
      );
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Owner (non-signer) tries to submit signature for a non-UpdateSigner op — should fail
      const messageHash = await vaultNoOwner.getOperationHash(operationId);
      const ownerSig = await owner.signMessage(ethers.getBytes(messageHash));
      await expect(
        vaultNoOwner.connect(owner).submitSignature(operationId, ownerSig)
      ).to.be.revertedWith("Only signers can submit signatures");
    });

    it("Should revert when submitting signature for a non-existent operation", async function () {
      const fakeOperationId = ethers.keccak256(ethers.toUtf8Bytes("nonexistent"));
      const messageHash = await vault.getOperationHash(fakeOperationId);
      const signature = await signers[0].signMessage(ethers.getBytes(messageHash));
      await expect(
        vault.connect(signers[0]).submitSignature(fakeOperationId, signature)
      ).to.be.revertedWith("Operation does not exist");
    });

    it("Should require three signatures", async function () {
      const newMaxAmount = ethers.parseUnits("25000", 18);
      const tx = await vault.requestOperation(OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, newMaxAmount, "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Only 2 signatures
      for (let i = 0; i < 2; i++) {
        const messageHash = await vault.getOperationHash(operationId);
        const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
        await vault.connect(signers[i]).submitSignature(operationId, signature);
      }
      expect(await vault.maxBridgeOutAmount()).to.not.equal(newMaxAmount);

      // Third signature executes
      const messageHash = await vault.getOperationHash(operationId);
      const signature = await signers[2].signMessage(ethers.getBytes(messageHash));
      await vault.connect(signers[2]).submitSignature(operationId, signature);
      expect(await vault.maxBridgeOutAmount()).to.equal(newMaxAmount);
    });

    it("Should enforce 3-day operation deadline", async function () {
      const tx = await vault.requestOperation(OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, ethers.parseUnits("20000", 18), "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      // Fast forward 3 days + 1 second
      await network.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await network.provider.send("evm_mine");

      const messageHash = await vault.getOperationHash(operationId);
      const signature = await signers[0].signMessage(ethers.getBytes(messageHash));
      await expect(
        vault.connect(signers[0]).submitSignature(operationId, signature)
      ).to.be.revertedWith("Operation deadline passed");
    });

    it("Should revert no-op bridgeOut status update", async function () {
      const enabledData = ethers.AbiCoder.defaultAbiCoder().encode(["bool"], [true]);
      await expect(
        requestAndSignOperation(vault, OP.SET_BRIDGE_OUT_ENABLED, ethers.ZeroAddress, 0, enabledData)
      ).to.be.revertedWith("Bridge-out status already set");
    });
  });

  describe("Helper Functions", function () {
    it("Should return correct vault balance", async function () {
      await setupLiberdusWithTokens();
      const bridgeAmount = ethers.parseUnits("1000", 18);
      await liberdus.connect(owner).approve(await vault.getAddress(), bridgeAmount);
      await vault.connect(owner).bridgeOut(bridgeAmount, recipient.address, chainId);

      expect(await vault.getVaultBalance()).to.equal(bridgeAmount);
    });

    it("Should check operation expiry correctly", async function () {
      const tx = await vault.requestOperation(OP.SET_BRIDGE_OUT_AMOUNT, ethers.ZeroAddress, ethers.parseUnits("30000", 18), "0x");
      const receipt = await tx.wait();
      const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

      expect(await vault.isOperationExpired(operationId)).to.be.false;

      await network.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
      await network.provider.send("evm_mine");

      expect(await vault.isOperationExpired(operationId)).to.be.true;
    });
  });
});
