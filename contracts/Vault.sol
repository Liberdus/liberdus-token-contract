// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract Vault is ReentrancyGuard, Ownable {
    using ECDSA for bytes32;

    enum OperationType {
        SetBridgeOutAmount,
        UpdateSigner,
        SetBridgeOutEnabled,
        RelinquishTokens
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
    uint256 public operationCount;

    uint256 public constant OPERATION_DEADLINE = 3 days;

    IERC20 public immutable token;
    uint256 public maxBridgeOutAmount = 10_000 * 10**18;
    bool public bridgeOutEnabled = true;
    bool public halted = false;

    address[4] public signers;
    uint256 public constant REQUIRED_SIGNATURES = 3;
    uint256 public immutable chainId;

    // Events
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

    event BridgeOutAmountUpdated(
        bytes32 indexed operationId,
        uint256 newMaxAmount,
        uint256 timestamp
    );

    event BridgedOut(
        address indexed from,
        uint256 amount,
        address indexed targetAddress,
        uint256 indexed chainId,
        uint256 timestamp
    );

    event SignerUpdated(
        bytes32 indexed operationId,
        address indexed oldSigner,
        address indexed newSigner,
        uint256 timestamp
    );

    event TokensRelinquished(
        address indexed to,
        uint256 amount,
        uint256 timestamp
    );

    event BridgeOutStatusUpdated(
        bytes32 indexed operationId,
        bool enabled,
        uint256 timestamp
    );

    event VaultHalted(uint256 timestamp);

    modifier onlySigner() {
        require(isSigner(msg.sender), "Not a signer");
        _;
    }

    modifier whenNotHalted() {
        require(!halted, "Vault is permanently halted");
        _;
    }

    constructor(address _token, address[4] memory _signers, uint256 _chainId) Ownable(msg.sender) {
        require(_token != address(0), "Invalid token address");

        for (uint i = 0; i < _signers.length; i++) {
            require(_signers[i] != address(0), "Invalid signer address");
            for (uint j = 0; j < i; j++) {
                require(_signers[i] != _signers[j], "Duplicate signer address");
            }
        }

        token = IERC20(_token);
        signers = _signers;
        chainId = _chainId;
    }

    // --------- MULTI-SIG OPERATIONS ---------

    function requestOperation(
        OperationType opType,
        address target,
        uint256 value,
        bytes memory data
    ) public whenNotHalted returns (bytes32) {
        require(isSigner(msg.sender) || owner() == msg.sender, "Not authorized to request operation");

        if (opType == OperationType.UpdateSigner) {
            address oldSigner = target;
            address newSigner = address(uint160(value));
            require(isSigner(oldSigner), "Old signer not found");
            require(!isSigner(newSigner), "New signer already exists");
            require(oldSigner != msg.sender, "Cannot request to replace self");
        }

        uint256 deadline = block.timestamp + OPERATION_DEADLINE;
        bytes32 operationId = keccak256(abi.encodePacked(operationCount++, opType, target, value, data, chainId));
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

    function submitSignature(bytes32 operationId, bytes memory signature) public whenNotHalted {
        Operation storage op = operations[operationId];
        // deadline is always set on creation; a zero value means the operationId was never registered
        require(op.deadline != 0, "Operation does not exist");
        require(!op.executed, "Operation already executed");
        require(!op.signatures[msg.sender], "Signature already submitted");
        require(block.timestamp <= op.deadline, "Operation deadline passed");

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

        require(op.numSignatures < REQUIRED_SIGNATURES, "Enough signatures already");

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
        } else if (op.opType == OperationType.SetBridgeOutAmount) {
            _executeSetBridgeOutAmount(operationId, op.value);
        } else if (op.opType == OperationType.RelinquishTokens) {
            _executeRelinquishTokens();
        } else if (op.opType == OperationType.SetBridgeOutEnabled) {
            _executeSetBridgeOutEnabled(operationId, abi.decode(op.data, (bool)));
        } else {
            revert("Unknown operation type");
        }

        emit OperationExecuted(operationId, op.opType);
    }

    function _executeSetBridgeOutAmount(bytes32 operationId, uint256 newMaxAmount) internal {
        require(newMaxAmount > 0, "Max amount must be greater than zero");
        maxBridgeOutAmount = newMaxAmount;
        emit BridgeOutAmountUpdated(
            operationId,
            newMaxAmount,
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
    function _executeRelinquishTokens() internal {
        uint256 balance = token.balanceOf(address(this));
        require(balance > 0, "No tokens to relinquish");
        require(token.transfer(address(token), balance), "Token transfer failed");
        halted = true;
        emit TokensRelinquished(address(token), balance, block.timestamp);
        emit VaultHalted(block.timestamp);
    }

    function _executeSetBridgeOutEnabled(bytes32 operationId, bool enabled) internal {
        require(enabled != bridgeOutEnabled, "Bridge-out status already set");
        bridgeOutEnabled = enabled;
        emit BridgeOutStatusUpdated(operationId, enabled, block.timestamp);
    }

    // --------- BRIDGE OUT ---------

    function bridgeOut(uint256 amount, address targetAddress, uint256 _chainId) public whenNotHalted {
        require(bridgeOutEnabled, "Bridge-out disabled");
        require(_chainId == chainId, "Invalid chain ID");
        require(amount > 0, "Cannot bridge out zero tokens");
        require(amount <= maxBridgeOutAmount, "Amount exceeds bridge-out limit");
        require(targetAddress != address(0), "Invalid target address");
        require(amount <= token.balanceOf(msg.sender), "Insufficient balance");

        require(token.transferFrom(msg.sender, address(this), amount), "Token transfer failed");

        emit BridgedOut(msg.sender, amount, targetAddress, _chainId, block.timestamp);
    }

    // --------- HELPER FUNCTIONS ---------

    function isSigner(address account) public view returns (bool) {
        for (uint i = 0; i < signers.length; i++) {
            if (signers[i] == account) {
                return true;
            }
        }
        return false;
    }

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

    function getVaultBalance() public view returns (uint256) {
        return token.balanceOf(address(this));
    }
}
