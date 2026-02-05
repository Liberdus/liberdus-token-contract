const { expect } = require("chai");
const { ethers } = require("hardhat");

describe("Liberdus (Secondary Bridge Contract)", function () {
  let Liberdus;
  let liberdus;
  let owner, signer1, signer2, signer3, signer4, recipient, bridgeInCaller, other;
  let signers;
  let chainId;
  const destinationChainId = BigInt(137);
  const sourceChainId = BigInt(1);

  async function requestAndSignOperation(operationType, target, value, data) {
    const tx = await liberdus.requestOperation(operationType, target, value, data);
    const receipt = await tx.wait();

    const operationRequestedEvent = receipt.logs.find(log => log.fragment.name === 'OperationRequested');
    const operationId = operationRequestedEvent.args.operationId;

    for (let i = 0; i < 3; i++) {
      const messageHash = await liberdus.getOperationHash(operationId);
      const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
      await liberdus.connect(signers[i]).submitSignature(operationId, signature);
    }

    return operationId
  }

  beforeEach(async function () {
    [owner, signer1, signer2, signer3, signer4, recipient, bridgeInCaller, other] = await ethers.getSigners();
    signers = [owner, signer1, signer2, signer3];
    chainId = BigInt((await ethers.provider.getNetwork()).chainId);

    const Liberdus = await ethers.getContractFactory("LiberdusSecondary");
    liberdus = await Liberdus.deploy([owner.address, signer1.address, signer2.address, signer3.address], chainId);
    await liberdus.waitForDeployment();
  });

  it('Should deploy the contract correctly with four signers', async function () {
    expect(await liberdus.name()).to.equal("Liberdus");
    expect(await liberdus.symbol()).to.equal("LIB");
    expect(await liberdus.getChainId()).to.equal(chainId);
    for (let i = 0; i < 4; i++) {
      expect(await liberdus.isSigner(signers[i].address)).to.be.true
    }
  });

  it("Should set bridge in caller via multisig", async function () {
    await requestAndSignOperation(3, bridgeInCaller.address, 0, "0x");
    expect(await liberdus.bridgeInCaller()).to.equal(bridgeInCaller.address);
  });

  it("Should set bridge in limits via multisig", async function () {
    const newMaxAmount = ethers.parseUnits('20000', 18);
    const newCooldown = BigInt(2 * 60);
    const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(['uint256'], [newCooldown]);

    await requestAndSignOperation(4, ethers.ZeroAddress, newMaxAmount, encodedData);
    expect(await liberdus.maxBridgeInAmount()).to.equal(newMaxAmount);
    expect(await liberdus.bridgeInCooldown()).to.equal(newCooldown);
  });

  it("Should not allow bridgeIn or bridgeOut before post-launch", async function () {
    // Set bridgeInCaller
    await requestAndSignOperation(3, bridgeInCaller.address, 0, "0x");
    // Try to bridge in
    const bridgeInAmount = ethers.parseUnits("1000", 18);
    await expect(
      liberdus.connect(bridgeInCaller)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, ethers.id("testTxId"), sourceChainId)
    ).to.be.revertedWith("Bridge in not available in pre-launch");

    // Try to bridge out
    await expect(
      liberdus.connect(recipient)["bridgeOut(uint256,address,uint256,uint256)"](bridgeInAmount, owner.address, chainId, destinationChainId)
    ).to.be.revertedWith("Bridge out not available in pre-launch");
  });

  it("Should enable bridgeIn and bridgeOut after post-launch", async function () {
    // Set bridgeInCaller and post-launch
    await requestAndSignOperation(0, ethers.ZeroAddress, 0, "0x"); // PostLaunch
    await requestAndSignOperation(3, bridgeInCaller.address, 0, "0x");

    // Bridge in tokens
    const bridgeInAmount = ethers.parseUnits("1000", 18);
    await liberdus.connect(bridgeInCaller)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, ethers.id("testTxId"), sourceChainId);
    expect(await liberdus.balanceOf(recipient.address)).to.equal(bridgeInAmount);

    // Bridge out tokens
    await liberdus.connect(recipient)["bridgeOut(uint256,address,uint256,uint256)"](bridgeInAmount, owner.address, chainId, destinationChainId);
    expect(await liberdus.balanceOf(recipient.address)).to.equal(0);
    expect(await liberdus.totalSupply()).to.equal(0);
  });

  it("Should not allow bridgeIn with wrong bridgeInCaller", async function () {
    await requestAndSignOperation(0, ethers.ZeroAddress, 0, "0x"); // PostLaunch
    await requestAndSignOperation(3, bridgeInCaller.address, 0, "0x");

    const bridgeInAmount = ethers.parseUnits("1000", 18);
    await expect(
      liberdus.connect(owner)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, ethers.id("testTxId"), sourceChainId)
    ).to.be.revertedWith("Not authorized to bridge in");
  });

  it("Should not allow bridgeIn or bridgeOut with wrong chainId", async function () {
    await requestAndSignOperation(0, ethers.ZeroAddress, 0, "0x"); // PostLaunch
    await requestAndSignOperation(3, bridgeInCaller.address, 0, "0x");

    const bridgeInAmount = ethers.parseUnits("1000", 18);
    const wrongChainId = chainId + BigInt(1);

    await expect(
      liberdus.connect(bridgeInCaller)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, wrongChainId, ethers.id("testTxId"), sourceChainId)
    ).to.be.revertedWith("Invalid chain ID");

    // Bridge in with correct chainId
    await liberdus.connect(bridgeInCaller)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, ethers.id("testTxId"), sourceChainId);

    // Bridge out with wrong chainId
    await expect(
      liberdus.connect(recipient)["bridgeOut(uint256,address,uint256,uint256)"](bridgeInAmount, owner.address, wrongChainId, destinationChainId)
    ).to.be.revertedWith("Invalid chain ID");

    // Bridge out with destinationChainId same as source chainId
    await expect(
      liberdus.connect(recipient)["bridgeOut(uint256,address,uint256,uint256)"](bridgeInAmount, owner.address, chainId, chainId)
    ).to.be.revertedWith("Destination chain must differ from source chain");
  });

  it("Should enforce maxBridgeInAmount and cooldown", async function () {
    await requestAndSignOperation(0, ethers.ZeroAddress, 0, "0x"); // PostLaunch
    await requestAndSignOperation(3, bridgeInCaller.address, 0, "0x");
    const tooMuch = ethers.parseUnits("10001", 18);

    await expect(
      liberdus.connect(bridgeInCaller)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, tooMuch, chainId, ethers.id("testTxId"), sourceChainId)
    ).to.be.revertedWith("Amount exceeds bridge-in limit");

    // Valid bridge-in
    const amount = ethers.parseUnits("1000", 18);
    await liberdus.connect(bridgeInCaller)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, amount, chainId, ethers.id("testTxId"), sourceChainId);

    // Try again before cooldown
    await expect(
      liberdus.connect(bridgeInCaller)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, amount, chainId, ethers.id("testTxId2"), sourceChainId)
    ).to.be.revertedWith("Bridge-in cooldown not met");
  });

  it("Should pause and unpause via multisig", async function () {
    await requestAndSignOperation(0, ethers.ZeroAddress, 0, "0x"); // PostLaunch
    await requestAndSignOperation(3, bridgeInCaller.address, 0, "0x");
    const bridgeInAmount = ethers.parseUnits("1000", 18);

    await liberdus.connect(bridgeInCaller)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, ethers.id("testTxId"), sourceChainId);

    await requestAndSignOperation(1, ethers.ZeroAddress, 0, "0x"); // Pause
    await expect(
      liberdus.connect(recipient).transfer(owner.address, bridgeInAmount)
    ).to.be.revertedWithCustomError(liberdus, "EnforcedPause");

    await requestAndSignOperation(2, ethers.ZeroAddress, 0, "0x"); // Unpause
    await liberdus.connect(recipient).transfer(owner.address, bridgeInAmount);
    expect(await liberdus.balanceOf(owner.address)).to.equal(bridgeInAmount);
  });

  it("Should require three signatures for multisig operations", async function () {
    const tx = await liberdus.requestOperation(3, bridgeInCaller.address, 0, "0x");
    const receipt = await tx.wait();
    const operationRequestedEvent = receipt.logs.find(log => log.fragment.name === 'OperationRequested');
    const operationId = operationRequestedEvent.args.operationId;

    // Only 2 signatures, should not execute
    for (let i = 0; i < 2; i++) {
      const messageHash = await liberdus.getOperationHash(operationId);
      const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
      await liberdus.connect(signers[i]).submitSignature(operationId, signature);
    }
    expect(await liberdus.bridgeInCaller()).to.not.equal(bridgeInCaller.address);

    // Third signature, should execute
    const messageHash = await liberdus.getOperationHash(operationId);
    const signature = await signers[2].signMessage(ethers.getBytes(messageHash));
    await liberdus.connect(signers[2]).submitSignature(operationId, signature);

    expect(await liberdus.bridgeInCaller()).to.equal(bridgeInCaller.address);
  });

  it("Should update signer correctly (no self-approval)", async function () {
    const newSigner = signer4;
    const oldSigner = signer3;

    // Prepare operation
    const tx = await liberdus.requestOperation(5, oldSigner.address, BigInt(newSigner.address), "0x");
    const receipt = await tx.wait();
    const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

    // Only three unique signers, none are oldSigner
    const signersToSign = signers.filter(s => s !== oldSigner).slice(0, 3);
    for (const signer of signersToSign) {
      const messageHash = await liberdus.getOperationHash(operationId);
      const signature = await signer.signMessage(ethers.getBytes(messageHash));
      await liberdus.connect(signer).submitSignature(operationId, signature);
    }
    expect(await liberdus.isSigner(newSigner.address)).to.be.true;
    expect(await liberdus.isSigner(oldSigner.address)).to.be.false;

    // Ensure oldSigner cannot sign anymore
    const tx2 = await liberdus.requestOperation(3, bridgeInCaller.address, 0, "0x");
    const receipt2 = await tx2.wait();
    const opId2 = receipt2.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;
    const sig = await oldSigner.signMessage(ethers.getBytes(await liberdus.getOperationHash(opId2)));
    await expect(
      liberdus.connect(oldSigner).submitSignature(opId2, sig)
    ).to.be.revertedWith("Only signers can submit signatures");
  });

  it("Should include chainId in operation hash", async function () {
    const operationType = 3;
    const target = bridgeInCaller.address;
    const value = 0;
    const data = "0x";
    const tx = await liberdus.requestOperation(operationType, target, value, data);
    const receipt = await tx.wait();
    const operationRequestedEvent = receipt.logs.find(log => log.fragment.name === 'OperationRequested');
    const operationId = operationRequestedEvent.args.operationId;

    const operationHash = await liberdus.getOperationHash(operationId);

    // Deploy on different chain id
    const differentChainId = chainId + BigInt(1);
    const Liberdus2 = await ethers.getContractFactory("LiberdusSecondary");
    const liberdus2 = await Liberdus2.deploy(
      [owner.address, signer1.address, signer2.address, signer3.address],
      differentChainId
    );
    await liberdus2.waitForDeployment();

    const operationHash2 = await liberdus2.getOperationHash(operationId);
    expect(operationHash).to.not.equal(operationHash2);
  });

  it("Should enforce 3-day operation deadline", async function () {
    const tx = await liberdus.requestOperation(3, bridgeInCaller.address, 0, "0x");
    const receipt = await tx.wait();
    const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

    // Fast forward 3 days + 1 second
    await network.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
    await network.provider.send("evm_mine");

    const messageHash = await liberdus.getOperationHash(operationId);
    const signature = await signers[0].signMessage(ethers.getBytes(messageHash));
    await expect(
      liberdus.connect(signers[0]).submitSignature(operationId, signature)
    ).to.be.revertedWith("Operation deadline passed");
  });

  it("Should allow transfer and transferFrom when not paused", async function () {
    await requestAndSignOperation(0, ethers.ZeroAddress, 0, "0x"); // PostLaunch
    await requestAndSignOperation(3, bridgeInCaller.address, 0, "0x");
    const bridgeInAmount = ethers.parseUnits("1000", 18);
    await liberdus.connect(bridgeInCaller)["bridgeIn(address,uint256,uint256,bytes32,uint256)"](recipient.address, bridgeInAmount, chainId, ethers.id("testTxId"), sourceChainId);

    await liberdus.connect(recipient).approve(owner.address, bridgeInAmount);
    await liberdus.connect(owner).transferFrom(recipient.address, owner.address, bridgeInAmount);
    expect(await liberdus.balanceOf(owner.address)).to.equal(bridgeInAmount);
  });

  it("Should allow bridgeOut and bridgeIn without optional chainId params", async function () {
    await requestAndSignOperation(0, ethers.ZeroAddress, 0, "0x"); // PostLaunch
    await requestAndSignOperation(3, bridgeInCaller.address, 0, "0x");

    // Bridge in without sourceChainId
    const bridgeInAmount = ethers.parseUnits("1000", 18);
    await liberdus.connect(bridgeInCaller)["bridgeIn(address,uint256,uint256,bytes32)"](
      recipient.address, bridgeInAmount, chainId, ethers.id("testTxId")
    );
    expect(await liberdus.balanceOf(recipient.address)).to.equal(bridgeInAmount);

    // Bridge out without destinationChainId
    await liberdus.connect(recipient)["bridgeOut(uint256,address,uint256)"](
      bridgeInAmount, owner.address, chainId
    );
    expect(await liberdus.balanceOf(recipient.address)).to.equal(0);
  });
});
