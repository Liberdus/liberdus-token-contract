const { expect } = require("chai");
const { ethers } = require("hardhat");
const { ZeroAddress } = ethers;

describe("LiberdusToken", function () {
    let LiberdusToken;
    let liberdus;
    let owner;
    let signer1;
    let signer2;
    let signer3;
    let signer4 // New signer for 4-signer setup
    let recipient;
    let bridgeInCaller;
    let signers;

    async function requestAndSignOperation(operationType, target, value, data) {
        const tx = await liberdus.requestOperation(operationType, target, value, data);
        const receipt = await tx.wait();

        const operationRequestedEvent = receipt.logs.find(log => log.fragment.name === 'OperationRequested');
        const operationId = operationRequestedEvent.args.operationId;

        // Modified to only get 3 signatures regardless of number of signers
        for (let i = 0; i < 3; i++) {
            const messageHash = await liberdus.getOperationHash(operationId);
            const signature = await signers[i].signMessage(ethers.getBytes(messageHash));
            await liberdus.connect(signers[i]).submitSignature(operationId, signature);
        }

        return operationId
    }

    beforeEach(async function () {
        const accounts = await ethers.getSigners();
        // Modified to include signer4
        [owner, signer1, signer2, signer3, signer4, recipient, bridgeInCaller] = accounts
        // Modified to use 4 signers
        signers = [owner, signer1, signer2, signer3]

        chainId = BigInt((await ethers.provider.getNetwork()).chainId);

        const LiberdusToken = await ethers.getContractFactory("Liberdus");
        // Modified constructor call to include 4 signers
        liberdus = await LiberdusToken.deploy([owner.address, signer1.address, signer2.address, signer3.address], chainId)
        await liberdus.waitForDeployment();
    });

    // Modified test
    it('Should deploy the contract correctly with four signers', async function () {
        expect(await liberdus.name()).to.equal("Liberdus");
        expect(await liberdus.symbol()).to.equal("LBD");
        expect(await liberdus.getChainId()).to.equal(chainId);

        // Verify all four signers
        for (let i = 0; i < 4; i++) {
            expect(await liberdus.isSigner(signers[i].address)).to.be.true
        }
    });

    // New test
    it('Should mint tokens to contract address', async function () {
        await requestAndSignOperation(0, owner.address, 0, '0x')

        const contractBalance = await liberdus.balanceOf(await liberdus.getAddress())
        expect(ethers.formatUnits(contractBalance, 18)).to.equal('3000000.0')

        // Verify owner received no tokens
        const ownerBalance = await liberdus.balanceOf(owner.address)
        expect(ownerBalance).to.equal(0)
    })

    // New test
    it('Should allow distribution of tokens from contract', async function () {
        // First mint tokens to contract
        await requestAndSignOperation(0, owner.address, 0, '0x')

        // Request token distribution
        const distributionAmount = ethers.parseUnits('1000', 18)
        await requestAndSignOperation(8, recipient.address, distributionAmount, '0x')

        // Verify recipient received tokens
        const recipientBalance = await liberdus.balanceOf(recipient.address)
        expect(ethers.formatUnits(recipientBalance, 18)).to.equal('1000.0')

        // Verify contract balance decreased
        const contractBalance = await liberdus.balanceOf(await liberdus.getAddress())
        expect(ethers.formatUnits(contractBalance, 18)).to.equal('2999000.0')
    })

    // New test
    it('Should burn tokens from contract balance', async function () {
        // First mint tokens to contract
        await requestAndSignOperation(0, owner.address, 0, '0x')

        const initialContractBalance = await liberdus.balanceOf(await liberdus.getAddress())
        const burnAmount = initialContractBalance / BigInt(2)

        // Burn half of the tokens
        await requestAndSignOperation(1, ZeroAddress, burnAmount, '0x')

        const finalContractBalance = await liberdus.balanceOf(await liberdus.getAddress())
        expect(finalContractBalance).to.equal(initialContractBalance - burnAmount)
    })

    // New test
    it('Should fail distribution if contract has insufficient balance', async function () {
        // Try to distribute without minting first
        const distributionAmount = ethers.parseUnits('1000', 18)

        await expect(
            requestAndSignOperation(8, recipient.address, distributionAmount, '0x')
        ).to.be.revertedWith('Insufficient contract balance')
    });

    it("Should prevent signature replay from another signer", async function () {
        const operationType = 0; // Mint operation
        const target = owner.address;
        const value = 0;
        const data = "0x";

        const tx = await liberdus.requestOperation(operationType, target, value, data);
        const receipt = await tx.wait();

        const operationRequestedEvent = receipt.logs.find(log => log.fragment.name === 'OperationRequested');
        const operationId = operationRequestedEvent.args.operationId;

        const messageHash = await liberdus.getOperationHash(operationId);
        const ownerSignature = await owner.signMessage(ethers.getBytes(messageHash));

        await expect(
            liberdus.connect(signer1).submitSignature(operationId, ownerSignature)
        ).to.be.revertedWith("Signature signer must be message sender");

        const operation = await liberdus.operations(operationId);
        expect(operation.executed).to.be.false;
        expect(operation.numSignatures).to.equal(0);
    });

    it("Should validate correct signer is submitting their own signature", async function () {
        const operationType = 0; // Mint operation
        const target = owner.address;
        const value = 0;
        const data = "0x";

        const tx = await liberdus.requestOperation(operationType, target, value, data);
        const receipt = await tx.wait();

        const operationRequestedEvent = receipt.logs.find(log => log.fragment.name === 'OperationRequested');
        const operationId = operationRequestedEvent.args.operationId;

        const signatures = [];
        for (let i = 0; i < 3; i++) { // Modified to only use 3 signatures
            const messageHash = await liberdus.getOperationHash(operationId);
            signatures[i] = await signers[i].signMessage(ethers.getBytes(messageHash));
        }

        await expect(
            liberdus.connect(signer1).submitSignature(operationId, signatures[2])
        ).to.be.revertedWith("Signature signer must be message sender");

        for (let i = 0; i < 3; i++) { // Modified to only use 3 signatures
            await liberdus.connect(signers[i]).submitSignature(operationId, signatures[i]);
        }

        const operation = await liberdus.operations(operationId);
        expect(operation.executed).to.be.true;
        expect(operation.numSignatures).to.equal(3) // Modified expected number of signatures
    });

    // Modified test to check minting to contract
    it("Should allow first mint and prevent immediate second mint", async function () {
        await requestAndSignOperation(0, owner.address, 0, "0x");

        const contractBalance = await liberdus.balanceOf(await liberdus.getAddress())
        expect(ethers.formatUnits(contractBalance, 18)).to.equal('3000000.0')

        await expect(
            requestAndSignOperation(0, owner.address, 0, "0x")
        ).to.be.revertedWith("Mint interval not reached");

        const contractBalanceAfterSecondMint = await liberdus.balanceOf(await liberdus.getAddress())
        expect(ethers.formatUnits(contractBalanceAfterSecondMint, 18)).to.equal('3000000.0')
    });

    it("Should set bridge in caller correctly", async function () {
        await requestAndSignOperation(5, bridgeInCaller.address, 0, "0x");

        const setCallerAddress = await liberdus.bridgeInCaller();
        expect(setCallerAddress).to.equal(bridgeInCaller.address);
    });

    it("Should change to post-launch mode", async function () {
        expect(await liberdus.isPreLaunch()).to.be.true;

        await requestAndSignOperation(2, ZeroAddress, 0, "0x");

        expect(await liberdus.isPreLaunch()).to.be.false;
    });

    it("Should allow bridging in and out in post-launch mode with correct chain ID", async function () {
        await requestAndSignOperation(2, ZeroAddress, 0, "0x");
        await requestAndSignOperation(5, bridgeInCaller.address, 0, "0x");

        const bridgeInAmount = ethers.parseUnits("1000", 18);
        await liberdus.connect(bridgeInCaller).bridgeIn(recipient.address, bridgeInAmount, chainId, ethers.id("testTxId"));

        let recipientBalance = await liberdus.balanceOf(recipient.address);
        expect(ethers.formatUnits(recipientBalance, 18)).to.equal("1000.0");

        const bridgeOutAmount = ethers.parseUnits("500", 18);
        await liberdus.connect(recipient).bridgeOut(bridgeOutAmount, owner.address, chainId);

        recipientBalance = await liberdus.balanceOf(recipient.address);
        expect(ethers.formatUnits(recipientBalance, 18)).to.equal("500.0");

        const totalSupplyAfterBridgeOut = await liberdus.totalSupply();
        expect(ethers.formatUnits(totalSupplyAfterBridgeOut, 18)).to.equal("500.0");
    });

    it("Should not allow bridging in with incorrect chain ID", async function () {
        await requestAndSignOperation(2, ZeroAddress, 0, "0x");
        await requestAndSignOperation(5, bridgeInCaller.address, 0, "0x");

        const bridgeInAmount = ethers.parseUnits("1000", 18);
        const incorrectChainId = chainId + BigInt(1);

        await expect(
            liberdus.connect(bridgeInCaller).bridgeIn(recipient.address, bridgeInAmount, incorrectChainId, ethers.id("testTxId"))
        ).to.be.revertedWith("Invalid chain ID");
    });

    it("Should not allow bridging out with incorrect chain ID", async function () {
        await requestAndSignOperation(2, ZeroAddress, 0, "0x");

        const bridgeOutAmount = ethers.parseUnits("500", 18);
        const incorrectChainId = chainId + BigInt(1);

        await expect(
            liberdus.connect(recipient).bridgeOut(bridgeOutAmount, owner.address, incorrectChainId)
        ).to.be.revertedWith("Invalid chain ID");
    });

    it("Should include chain ID in operation hash", async function () {
        const operationType = 0
        const target = owner.address;
        const value = 0;
        const data = "0x";

        const tx = await liberdus.requestOperation(operationType, target, value, data);
        const receipt = await tx.wait();

        const operationRequestedEvent = receipt.logs.find(log => log.fragment.name === 'OperationRequested');
        const operationId = operationRequestedEvent.args.operationId;

        const operationHash = await liberdus.getOperationHash(operationId);

        const differentChainId = chainId + BigInt(1);
        const LiberdusTokenDifferentChain = await ethers.getContractFactory("Liberdus");
        // Modified to use 4 signers in constructor
        const liberdusDifferentChain = await LiberdusTokenDifferentChain.deploy(
            [owner.address, signer1.address, signer2.address, signer3.address],
            differentChainId
        )
        await liberdusDifferentChain.waitForDeployment();

        const operationHashDifferentChain = await liberdusDifferentChain.getOperationHash(operationId);
        expect(operationHash).to.not.equal(operationHashDifferentChain);
    });

    it("Should set deadline to 3 days from request time", async function () {
        const tx = await liberdus.requestOperation(0, owner.address, 0, "0x");
        const receipt = await tx.wait();

        const event = receipt.logs.find(log => log.fragment.name === 'OperationRequested');
        const requestTime = event.args.timestamp;
        const deadline = event.args.deadline;

        // Convert values to BigInt and do the calculation
        const threeDays = BigInt(3 * 24 * 60 * 60); // 3 days in seconds as BigInt
        expect(deadline).to.equal(requestTime + threeDays);
    });

    it("Should reject signatures after 3 days", async function () {
        const tx = await liberdus.requestOperation(0, owner.address, 0, "0x");
        const receipt = await tx.wait();

        const operationId = receipt.logs.find(
            log => log.fragment.name === 'OperationRequested'
        ).args.operationId;

        // Increase time beyond 3 days
        await network.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 + 1]);
        await network.provider.send("evm_mine");

        const messageHash = await liberdus.getOperationHash(operationId);
        const signature = await signers[0].signMessage(ethers.getBytes(messageHash));

        await expect(
            liberdus.connect(signers[0]).submitSignature(operationId, signature)
        ).to.be.revertedWith("Operation deadline passed");
    });

    it("Should allow signatures within 3 days", async function () {
        const tx = await liberdus.requestOperation(0, owner.address, 0, "0x");
        const receipt = await tx.wait();

        const operationId = receipt.logs.find(
            log => log.fragment.name === 'OperationRequested'
        ).args.operationId;

        // Increase time to just before deadline
        await network.provider.send("evm_increaseTime", [3 * 24 * 60 * 60 - 60]); // 1 minute before deadline
        await network.provider.send("evm_mine");

        const messageHash = await liberdus.getOperationHash(operationId);
        const signature = await signers[0].signMessage(ethers.getBytes(messageHash));

        await expect(
            liberdus.connect(signers[0]).submitSignature(operationId, signature)
        ).to.not.be.reverted;
    });

    // Modified test to check burn from contract balance
    it("Should execute burn operation correctly", async function () {
        // First mint tokens to contract
        await requestAndSignOperation(0, owner.address, 0, "0x");
        const initialSupply = await liberdus.totalSupply();

        // Burn half of the minted amount
        const burnAmount = initialSupply / BigInt(2);
        await requestAndSignOperation(1, ZeroAddress, burnAmount, '0x')

        const finalSupply = await liberdus.totalSupply();
        expect(finalSupply).to.equal(initialSupply - burnAmount);
    });

    it("Should pause and unpause operations correctly", async function () {
        // First mint and distribute some tokens to test transfer
        await requestAndSignOperation(0, owner.address, 0, "0x");
        const amount = ethers.parseUnits("1000", 18);
        await requestAndSignOperation(8, recipient.address, amount, '0x')

        // Pause the contract
        await requestAndSignOperation(3, ZeroAddress, 0, "0x");

        // Try to transfer while paused
        await expect(
            liberdus.connect(recipient).transfer(owner.address, amount)
        ).to.be.revertedWithCustomError(liberdus, "EnforcedPause");

        // Unpause the contract
        await requestAndSignOperation(4, ZeroAddress, 0, "0x");

        // Transfer should work after unpause
        await expect(
            liberdus.connect(recipient).transfer(owner.address, amount)
        ).to.be.fulfilled;

        expect(await liberdus.balanceOf(owner.address)).to.equal(amount)
        expect(await liberdus.balanceOf(recipient.address)).to.equal(0)
    });

    it("Should set bridge in limits correctly", async function () {
        const newMaxAmount = ethers.parseUnits('20000', 18)
        const newCooldown = BigInt(2 * 60)

        const encodedData = ethers.AbiCoder.defaultAbiCoder().encode(
            ['uint256'],
            [newCooldown]
        );

        await requestAndSignOperation(6, ZeroAddress, newMaxAmount, encodedData);

        expect(await liberdus.maxBridgeInAmount()).to.equal(newMaxAmount);
        expect(await liberdus.bridgeInCooldown()).to.equal(newCooldown);
        // Test the new limits
        await requestAndSignOperation(2, ZeroAddress, 0, "0x"); // Switch to post-launch
        await requestAndSignOperation(5, bridgeInCaller.address, 0, "0x"); // Set bridge caller

        // Try to bridge in more than the new limit
        const tooMuchAmount = ethers.parseUnits("20001", 18);
        await expect(
            liberdus.connect(bridgeInCaller).bridgeIn(recipient.address, tooMuchAmount, chainId, ethers.id("testTxId"))
        ).to.be.revertedWith("Amount exceeds bridge-in limit");

        // Bridge in valid amount
        const validAmount = ethers.parseUnits("19999", 18);
        await liberdus.connect(bridgeInCaller).bridgeIn(recipient.address, validAmount, chainId, ethers.id("testTxId"));

        // Try to bridge in again before cooldown
        await expect(
            liberdus.connect(bridgeInCaller).bridgeIn(recipient.address, validAmount, chainId, ethers.id("testTxId"))
        ).to.be.revertedWith("Bridge-in cooldown not met");
    });

    // Modified test to require 3 signatures for signer update
    it('Should update signer correctly with three signatures', async function () {
        const newSigner = signer4
        const oldSigner = signer3

        const tx = await liberdus.requestOperation(7, oldSigner.address, BigInt(newSigner.address), "0x");
        const receipt = await tx.wait();

        const operationRequestedEvent = receipt.logs.find(log => log.fragment.name === 'OperationRequested');
        const operationId = operationRequestedEvent.args.operationId;

        // Get three signatures (not including the signer being replaced)
        const signersToSign = signers.filter(s => s !== oldSigner).slice(0, 3)
        for (const signer of signersToSign) {
            const messageHash = await liberdus.getOperationHash(operationId);
            const signature = await signer.signMessage(ethers.getBytes(messageHash))
            await liberdus.connect(signer).submitSignature(operationId, signature)
        }

        // Verify new signer is set
        expect(await liberdus.isSigner(newSigner.address)).to.be.true;
        expect(await liberdus.isSigner(oldSigner.address)).to.be.false;

        // Verify old signer can't sign operations anymore
        const mintOp = await liberdus.requestOperation(0, owner.address, 0, "0x");
        const mintReceipt = await mintOp.wait();
        const mintOpId = mintReceipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

        const oldSignerSignature = await oldSigner.signMessage(ethers.getBytes(await liberdus.getOperationHash(mintOpId)));
        await expect(
            liberdus.connect(oldSigner).submitSignature(mintOpId, oldSignerSignature)
        ).to.be.revertedWith("Only signers can submit signatures");
    });

    // Modified to test 3-signature requirement
    it('Should require exactly three signatures for signer update', async function () {
        const newSigner = signer4
        const oldSigner = signer3

        const tx = await liberdus.requestOperation(7, oldSigner.address, BigInt(newSigner.address), '0x')
        const receipt = await tx.wait()

        const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId

        // Submit only two signatures
        const signersToSign = signers.filter(s => s !== oldSigner).slice(0, 2)
        for (const signer of signersToSign) {
            const messageHash = await liberdus.getOperationHash(operationId)
            const signature = await signer.signMessage(ethers.getBytes(messageHash))
            await liberdus.connect(signer).submitSignature(operationId, signature)
        }

        // Verify signer hasn't been updated yet (operation not executed)
        expect(await liberdus.isSigner(newSigner.address)).to.be.false
        expect(await liberdus.isSigner(oldSigner.address)).to.be.true
    })

    it("Should prevent signer being replaced from approving their own replacement", async function () {
        const newSigner = signer4
        const oldSigner = signer3

        const tx = await liberdus.requestOperation(7, oldSigner.address, BigInt(newSigner.address), "0x");
        const receipt = await tx.wait();

        const operationId = receipt.logs.find(log => log.fragment.name === 'OperationRequested').args.operationId;

        // Try to sign with the signer being replaced
        const messageHash = await liberdus.getOperationHash(operationId);
        const signature = await oldSigner.signMessage(ethers.getBytes(messageHash));

        await expect(
            liberdus.connect(oldSigner).submitSignature(operationId, signature)
        ).to.be.revertedWith("Signer being replaced cannot approve");
    });

    // New test for multi-step token distribution
    it('Should handle multiple token distributions correctly', async function () {
        // First mint tokens to contract
        await requestAndSignOperation(0, owner.address, 0, '0x')

        const distribution1Amount = ethers.parseUnits('1000', 18)
        const distribution2Amount = ethers.parseUnits('2000', 18)

        // First distribution
        await requestAndSignOperation(8, recipient.address, distribution1Amount, '0x')
        expect(await liberdus.balanceOf(recipient.address)).to.equal(distribution1Amount)

        // Second distribution
        await requestAndSignOperation(8, signer4.address, distribution2Amount, '0x')
        expect(await liberdus.balanceOf(signer4.address)).to.equal(distribution2Amount)

        // Verify contract balance
        const expectedContractBalance = ethers.parseUnits('3000000', 18) - distribution1Amount - distribution2Amount
        expect(await liberdus.balanceOf(await liberdus.getAddress())).to.equal(expectedContractBalance)
    })
});
