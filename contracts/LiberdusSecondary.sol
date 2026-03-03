// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract LiberdusSecondary is ERC20, ReentrancyGuard, Ownable {
    using ECDSA for bytes32;

    enum OperationType {
        SetBridgeInCaller,
        SetBridgeInLimits,
        UpdateSigner,
        SetBridgeInEnabled,
        SetBridgeOutEnabled
    }

    struct Operation {
        OperationType opType;
        address target;
        uint256 value;
        bytes data;
        uint256 numSignatures;
        bool executed;
        uint256 deadline;
        mapping(address => bool) signatures;
    }

    mapping(bytes32 => Operation) public operations;
    mapping(bytes32 => bool) public processedTxIds;
    uint256 public operationCount;

    uint256 public constant OPERATION_DEADLINE = 3 days;

    address public bridgeInCaller;
    uint256 public maxBridgeInAmount = 10_000 * 10**18;
    uint256 public bridgeInCooldown = 1 minutes;
    uint256 public lastBridgeInTime;
    bool public bridgeInEnabled = true;
    bool public bridgeOutEnabled = false; // Set to true after Liberdus Mainnet launch
 
    address[4] public signers;
    uint256 public constant REQUIRED_SIGNATURES = 3;
    uint256 public immutable chainId;

    // Defining events for the contract
    event OperationRequested(
        bytes32 indexed operationId,
        OperationType indexed opType,
        address indexed requester,
        address target,
        uint256 value,
        bytes data,
        uint256 deadline,
        uint256 timestamp
    );

    event SignatureSubmitted(
        bytes32 indexed operationId,
        address indexed signer,
        uint256 currentSignatures,
        uint256 requiredSignatures,
        uint256 timestamp
    );

    event OperationExecuted(
        bytes32 indexed operationId,
        OperationType indexed opType
    );

    event BridgeInCallerUpdated(
        bytes32 indexed operationId,
        address indexed newCaller,
        uint256 timestamp
    );

    event BridgeInLimitsUpdated(
        bytes32 indexed operationId,
        uint256 newMaxAmount,
        uint256 newCooldown,
        uint256 timestamp
    );

    event BridgedOut(
        address indexed from,
        uint256 amount,
        address indexed targetAddress,
        uint256 indexed chainId,
        uint256 timestamp
    );

    event BridgedIn(
        address indexed to,
        uint256 amount,
        uint256 indexed chainId,
        bytes32 indexed txId,
        uint256 timestamp
    );

    event SignerUpdated(
        bytes32 indexed operationId,
        address indexed oldSigner,
        address indexed newSigner,
        uint256 timestamp
    );

    event BridgeInStatusUpdated(
        bytes32 indexed operationId,
        bool enabled,
        uint256 timestamp
    );

    event BridgeOutStatusUpdated(
        bytes32 indexed operationId,
        bool enabled,
        uint256 timestamp
    );

    modifier onlyBridgeInCaller() {
        require(msg.sender == bridgeInCaller, "Not authorized to bridge in");
        _;
    }

    constructor(address[4] memory _signers, uint256 _chainId) ERC20("Liberdus", "LIB") Ownable(msg.sender) {
        // Verify that all signer addresses are valid and unique
        for (uint i = 0; i < _signers.length; i++) {
            require(_signers[i] != address(0), "Invalid signer address");
            for (uint j = 0; j < i; j++) {
                require(_signers[i] != _signers[j], "Duplicate signer address");
            }
        }

        signers = _signers;
        chainId = _chainId;
    }

    function requestOperation(
        OperationType opType,
        address target,
        uint256 value,
        bytes memory data
    ) public returns (bytes32) {
        require(isSigner(msg.sender) || owner() == msg.sender, "Not authorized to request operation");

        if (opType == OperationType.UpdateSigner) {
            address oldSigner = target;
            address newSigner = address(uint160(value));
            require(isSigner(oldSigner), "Old signer not found");
            require(!isSigner(newSigner), "New signer already exists");
            require(oldSigner != msg.sender, "Cannot request to replace self");
        }

        uint256 deadline = block.timestamp + OPERATION_DEADLINE;
        bytes32 operationId = keccak256(abi.encodePacked(operationCount++, opType, target, value, data, chainId, address(this)));
        Operation storage op = operations[operationId];
        op.opType = opType;
        op.target = target;
        op.value = value;
        op.data = data;
        op.executed = false;
        op.numSignatures = 0;
        op.deadline = deadline;

        emit OperationRequested(
            operationId,
            opType,
            msg.sender,
            target,
            value,
            data,
            deadline,
            block.timestamp
        );
        return operationId;
    }

    function submitSignature(bytes32 operationId, bytes memory signature) public {
        Operation storage op = operations[operationId];
        // deadline is always set on creation; a zero value means the operationId was never registered
        require(op.deadline != 0, "Operation does not exist");
        require(!op.executed, "Operation already executed");
        require(!op.signatures[msg.sender], "Signature already submitted");
        require(block.timestamp <= op.deadline, "Operation deadline passed");
        require(op.numSignatures < REQUIRED_SIGNATURES, "Enough signatures already");

        if (op.opType == OperationType.UpdateSigner) {
            require(isSigner(msg.sender) || owner() == msg.sender, "Only signers or owner can submit signatures");
        } else {
            require(isSigner(msg.sender), "Only signers can submit signatures");
        }

        bytes32 messageHash = getOperationHash(operationId);
        // Add Ethereum Signed Message prefix
        bytes32 prefixedHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", messageHash));
        address signer = ECDSA.recover(prefixedHash, signature);

        require(signer == msg.sender, "Signature signer must be message sender");

        if (op.opType == OperationType.UpdateSigner) {
            require(signer != op.target, "Signer being replaced cannot approve");
        }

        op.signatures[signer] = true;
        op.numSignatures++;

        emit SignatureSubmitted(operationId, signer, op.numSignatures, REQUIRED_SIGNATURES, block.timestamp);

        if (op.numSignatures == REQUIRED_SIGNATURES) {
            executeOperation(operationId);
        }
    }

    function executeOperation(bytes32 operationId) internal nonReentrant {
        Operation storage op = operations[operationId];
        require(!op.executed, "Operation already executed");
        
        // Mark as executed before making any external calls
        op.executed = true;

        if (op.opType == OperationType.UpdateSigner) {
            _executeUpdateSigner(operationId, op.target, address(uint160(op.value)));
        } else if (op.opType == OperationType.SetBridgeInCaller) {
            _executeSetBridgeInCaller(operationId, op.target);
        } else if (op.opType == OperationType.SetBridgeInLimits) {
            _executeSetBridgeInLimits(operationId, op.value, abi.decode(op.data, (uint256)));
        } else if (op.opType == OperationType.SetBridgeInEnabled) {
            _executeSetBridgeInEnabled(operationId, abi.decode(op.data, (bool)));
        } else if (op.opType == OperationType.SetBridgeOutEnabled) {
            _executeSetBridgeOutEnabled(operationId, abi.decode(op.data, (bool)));
        } else {
            revert("Unknown operation type");
        }

        emit OperationExecuted(operationId, op.opType);
    }

    function _executeSetBridgeInCaller(bytes32 operationId, address newCaller) internal {
        require(newCaller != address(0), "Invalid bridge-in caller");
        require(newCaller != bridgeInCaller, "Bridge-in caller already set");
        bridgeInCaller = newCaller;
        emit BridgeInCallerUpdated(
            operationId,
            newCaller,
            block.timestamp
        );
    }

    function _executeSetBridgeInLimits(bytes32 operationId, uint256 newMaxAmount, uint256 newCooldown) internal {
        require(newMaxAmount > 0, "Max amount must be greater than zero");
        require(newCooldown > 0, "Cooldown must be greater than zero");
        maxBridgeInAmount = newMaxAmount;
        bridgeInCooldown = newCooldown;
        emit BridgeInLimitsUpdated(
            operationId,
            newMaxAmount,
            newCooldown,
            block.timestamp
        );
    }

    function _executeUpdateSigner(bytes32 operationId, address oldSigner, address newSigner) internal {
        require(isSigner(oldSigner), "Old signer not found");
        require(!isSigner(newSigner), "New signer already exists");
        
        for (uint i = 0; i < signers.length; i++) {
            if (signers[i] == oldSigner) {
                signers[i] = newSigner;
                break;
            }
        }
        emit SignerUpdated(
            operationId,
            oldSigner,
            newSigner,
            block.timestamp
        );
    }

    function _executeSetBridgeInEnabled(bytes32 operationId, bool enabled) internal {
        require(enabled != bridgeInEnabled, "Bridge-in status already set");
        bridgeInEnabled = enabled;
        emit BridgeInStatusUpdated(operationId, enabled, block.timestamp);
    }

    function _executeSetBridgeOutEnabled(bytes32 operationId, bool enabled) internal {
        require(enabled != bridgeOutEnabled, "Bridge-out status already set");
        bridgeOutEnabled = enabled;
        emit BridgeOutStatusUpdated(operationId, enabled, block.timestamp);
    }

    function bridgeOut(uint256 amount, address targetAddress, uint256 _chainId) public {
        require(bridgeOutEnabled, "Bridge-out disabled");
        require(_chainId == chainId, "Invalid chain ID");
        require(amount > 0, "Cannot bridge out zero tokens");
        require(amount <= maxBridgeInAmount, "Amount exceeds bridge-in limit");
        require(amount <= balanceOf(msg.sender), "Insufficient balance");
        _burn(msg.sender, amount);
        emit BridgedOut(msg.sender, amount, targetAddress, _chainId, block.timestamp);
    }

    function bridgeIn(address to, uint256 amount, uint256 _chainId, bytes32 txId) public onlyBridgeInCaller {
        require(bridgeInEnabled, "Bridge-in disabled");
        require(_chainId == chainId, "Invalid chain ID");
        require(amount > 0, "Cannot bridge in zero tokens");
        require(amount <= maxBridgeInAmount, "Amount exceeds bridge-in limit");
        require(!processedTxIds[txId], "Transaction already processed");
        require(block.timestamp >= lastBridgeInTime + bridgeInCooldown, "Bridge-in cooldown not met");

        _mint(to, amount);
        processedTxIds[txId] = true;
        lastBridgeInTime = block.timestamp;
        emit BridgedIn(to, amount, _chainId, txId, block.timestamp);
    }

    function isSigner(address account) public view returns (bool) {
        for (uint i = 0; i < signers.length; i++) {
            if (signers[i] == account) {
                return true;
            }
        }
        return false;
    }

    // --------- HELPER FUNCTIONS ---------
    function getOperationHash(bytes32 operationId) public view returns (bytes32) {
        Operation storage op = operations[operationId];
        return keccak256(abi.encodePacked(operationId, op.opType, op.target, op.value, op.data, chainId));
    }

    function getChainId() public view returns (uint256) {
        return chainId;
    }

    function isOperationExpired(bytes32 operationId) public view returns (bool) {
        return block.timestamp > operations[operationId].deadline;
    }

}
