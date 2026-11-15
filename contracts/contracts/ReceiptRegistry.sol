// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {SignatureCheckerParis} from "./utils/SignatureCheckerParis.sol";

/// @title Hemi agent receipt registry
/// @notice Anchors hashes of signed AI-agent run manifests on Hemi, either as a Merkle
///         root covering many receipts (`attestBatch`) or one receipt at a time
///         (`attest`), and proves later that a receipt was anchored.
/// @dev Implements docs/SCHEMA.md §3 to §5 exactly. Not upgradeable.
///
///      Trust model, stated plainly.
///
///        - The service signer is trusted to batch honestly. On the batch path the
///          contract sees only a root and a leaf count. It cannot tell whether every
///          leaf under the root carries a valid agent signature, whether `count` is
///          the true number of leaves, or whether a run id appears in two batches.
///          The service checks all of that off chain, and a verifier re-checks the
///          agent signature from the receipt file.
///        - On the direct path (`attest`) the contract checks both signatures: the
///          agent's (or its principal's) over the Receipt struct, and the service's
///          over a domain-separated envelope that commits to the agent's FULL
///          EIP-712 digest. One signature can never satisfy both checks, even when
///          the agent and the service are the same key.
///        - Anyone may submit and pay for either write. The signatures bind every
///          stored field, so a relayer cannot change what gets recorded.
///        - Replay is stopped by uniqueness, not by nonces: a root can be anchored
///          once, and a run id once on the direct path. The service signature also
///          carries a deadline no more than `MAX_DEADLINE_WINDOW` ahead of the block.
///        - What the contract does NOT do: it does not read or validate manifests,
///          it does not stop the service from anchoring a root it should not have,
///          and an EIP-1271 wallet's answer is only checked at submission (contract
///          signatures are revocable; a later revocation does not undo an anchor).
///        - The owner is the incident-response key, kept separate from the service
///          key: it can pause both writes, void a batch by naming its exact root,
///          rotate the service signer, and enable or disable schema versions. It
///          can never be the service signer and it can never be renounced. A void
///          keeps the root spent, so a voided batch cannot be re-anchored.
contract ReceiptRegistry is EIP712, Ownable2Step, Pausable {
    /// @notice The five fields that go on chain for one receipt.
    struct Receipt {
        bytes32 runId;
        bytes32 manifestHash;
        address agent;
        address principal;
        uint16 schemaVersion;
    }

    /// @notice One anchored root. A direct attestation is a batch of one whose root is the leaf.
    struct Batch {
        bytes32 root;
        uint32 count;
        uint16 schemaVersion;
        bool voided;
        address serviceSigner;
        uint64 attestedAt;
        uint64 blockNumber;
    }

    /// @notice Longest a service signature may stay submittable once it reaches the chain.
    uint64 public constant MAX_DEADLINE_WINDOW = 1 hours;

    /// @notice Largest leaf count a batch may claim.
    uint32 public constant MAX_BATCH_COUNT = 65_536;

    /// @notice Signed by the agent or its principal.
    bytes32 public constant RECEIPT_TYPEHASH = keccak256(
        "Receipt(bytes32 runId,bytes32 manifestHash,address agent,address principal,uint16 schemaVersion)"
    );

    /// @notice Signed by the service for the batch path.
    bytes32 public constant BATCH_ATTESTATION_TYPEHASH =
        keccak256("BatchAttestation(bytes32 root,uint32 count,uint16 schemaVersion,uint64 deadline)");

    /// @notice Signed by the service for the direct path.
    /// @dev `receiptDigest` is the agent's FULL EIP-712 digest (0x1901 ‖ domainSeparator ‖
    ///      structHash), not the struct hash. This domain-separates the service's
    ///      signature from the agent's, so one signature never satisfies both checks.
    bytes32 public constant SERVICE_ATTESTATION_TYPEHASH =
        keccak256("ServiceAttestation(bytes32 receiptDigest,uint64 deadline)");

    error InvalidServiceSigner();
    error InvalidReceipt();
    error InvalidBatch();
    error SchemaVersionDisabled(uint16 version);
    error ExpiredSignature(uint64 deadline);
    error DeadlineTooDistant(uint64 deadline);
    error DuplicateRun(bytes32 runId, uint256 batchId);
    error RootAlreadyAttested(bytes32 root, uint256 batchId);
    error InvalidAgentSignature();
    error InvalidServiceSignature();
    error UnknownBatch(uint256 batchId);
    error BatchAlreadyVoided(uint256 batchId);
    error VoidTargetMismatch(bytes32 stored, bytes32 expected);
    error RenounceDisabled();

    /// @dev Together with the log's block (timestamp and number) and any later `BatchVoided`,
    ///      this carries every stored Batch field, so an indexer can rebuild all batches
    ///      from logs alone.
    event BatchAttested(
        uint256 indexed batchId,
        bytes32 indexed root,
        address indexed serviceSigner,
        uint32 count,
        uint16 schemaVersion
    );
    /// @dev Emitted on the direct path only, after `BatchAttested` for the same batch.
    event ReceiptAttested(
        bytes32 indexed runId,
        address indexed agent,
        address indexed principal,
        bytes32 manifestHash,
        uint256 batchId,
        uint16 schemaVersion
    );
    event BatchVoided(uint256 indexed batchId, bytes32 indexed root, string reason);
    event ServiceSignerUpdated(address indexed previousSigner, address indexed newSigner);
    event SchemaVersionSet(uint16 indexed version, bool enabled);

    /// @notice The key whose signature authorizes every anchor.
    address public serviceSigner;

    /// @notice Number of batches anchored so far. Batch ids run from 1 to `batchCount`.
    uint256 public batchCount;

    mapping(uint16 version => bool) public schemaVersionEnabled;

    /// @notice The batch that anchored `root`; 0 if it was never anchored. Survives a void.
    mapping(bytes32 root => uint256) public batchIdOfRoot;

    /// @notice The direct-path batch that anchored `runId`; 0 if unused. Batched runs are not
    ///         tracked here, because the contract only sees their root.
    mapping(bytes32 runId => uint256) public batchIdOfRun;

    mapping(uint256 batchId => Batch) private _batches;

    /// @param initialOwner The incident-response key. Must differ from the service signer.
    /// @param initialServiceSigner The service's signing key. Not zero, not the owner.
    constructor(
        address initialOwner,
        address initialServiceSigner
    ) EIP712("HemiAgentReceipts", "1") Ownable(initialOwner) {
        if (initialServiceSigner == address(0) || initialServiceSigner == initialOwner) {
            revert InvalidServiceSigner();
        }
        serviceSigner = initialServiceSigner;
        emit ServiceSignerUpdated(address(0), initialServiceSigner);

        schemaVersionEnabled[1] = true;
        emit SchemaVersionSet(1, true);
    }

    /* -------------------------------- anchoring -------------------------------- */

    /// @notice Anchor a Merkle root covering `count` receipts of one schema version.
    /// @dev Anyone may submit; the service signature over (root, count, schemaVersion,
    ///      deadline) is what authorizes it.
    function attestBatch(
        bytes32 root,
        uint32 count,
        uint16 schemaVersion,
        uint64 deadline,
        bytes calldata serviceSignature
    ) external whenNotPaused returns (uint256 batchId) {
        if (root == bytes32(0) || count == 0 || count > MAX_BATCH_COUNT) revert InvalidBatch();
        _checkSchemaVersion(schemaVersion);
        _checkDeadline(deadline);
        _checkRootUnused(root);
        _checkServiceSignature(_batchAttestationDigest(root, count, schemaVersion, deadline), serviceSignature);

        batchId = _recordBatch(root, count, schemaVersion);
    }

    /// @notice Anchor one receipt directly, as a batch of one whose root is the leaf.
    /// @dev The agent (or its principal) signs the Receipt struct; the service signs a
    ///      ServiceAttestation over the agent's full digest and a deadline.
    function attest(
        Receipt calldata receipt,
        bytes calldata agentSignature,
        uint64 deadline,
        bytes calldata serviceSignature
    ) external whenNotPaused returns (uint256 batchId) {
        bytes32 leaf = _checkReceipt(receipt, deadline);
        bytes32 digest = _receiptDigest(receipt);
        if (!_isValidAgentSignature(receipt.agent, receipt.principal, digest, agentSignature)) {
            revert InvalidAgentSignature();
        }
        _checkServiceSignature(_serviceAttestationDigest(digest, deadline), serviceSignature);

        batchId = _recordBatch(leaf, 1, receipt.schemaVersion);
        batchIdOfRun[receipt.runId] = batchId;
        emit ReceiptAttested(
            receipt.runId,
            receipt.agent,
            receipt.principal,
            receipt.manifestHash,
            batchId,
            receipt.schemaVersion
        );
    }

    /* ------------------------------- verification ------------------------------- */

    /// @notice True when `leaf` is under the root of a live (known, not voided) batch.
    /// @dev Sorted-pair proof, OpenZeppelin `MerkleProof`. This accepts any node of the
    ///      tree, including an internal one with a shorter proof. To prove a receipt, use
    ///      `verifyReceipt`, which derives the 128-byte-preimage leaf itself. Returns false
    ///      (never reverts) for an unknown batch.
    function verifyInclusion(uint256 batchId, bytes32 leaf, bytes32[] calldata proof) public view returns (bool) {
        if (batchId == 0 || batchId > batchCount) return false;
        Batch storage batch = _batches[batchId];
        if (batch.voided) return false;
        return MerkleProof.verifyCalldata(proof, batch.root, leaf);
    }

    /// @notice True when `receipt` is in a live batch of the same schema version.
    /// @dev Does not check the agent's signature on batched receipts; a verifier does that
    ///      from the receipt file (and the contract already did on the direct path).
    function verifyReceipt(
        uint256 batchId,
        Receipt calldata receipt,
        bytes32[] calldata proof
    ) external view returns (bool) {
        if (!verifyInclusion(batchId, _leafHash(receipt), proof)) return false;
        return _batches[batchId].schemaVersion == receipt.schemaVersion;
    }

    /// @notice keccak256(abi.encode(runId, manifestHash, agent, principal)). docs/SCHEMA.md §3.
    function leafHash(
        bytes32 runId,
        bytes32 manifestHash,
        address agent,
        address principal
    ) public pure returns (bytes32) {
        return keccak256(abi.encode(runId, manifestHash, agent, principal));
    }

    /// @notice The full EIP-712 digest the agent (or principal) signs.
    function receiptDigest(Receipt calldata receipt) external view returns (bytes32) {
        return _receiptDigest(receipt);
    }

    /// @notice The full EIP-712 digest the service signs for the direct path.
    /// @param receiptDigest The agent's full digest, from `receiptDigest(receipt)`.
    function serviceAttestationDigest(bytes32 receiptDigest, uint64 deadline) external view returns (bytes32) {
        return _serviceAttestationDigest(receiptDigest, deadline);
    }

    /// @notice The full EIP-712 digest the service signs for the batch path.
    function batchAttestationDigest(
        bytes32 root,
        uint32 count,
        uint16 schemaVersion,
        uint64 deadline
    ) external view returns (bytes32) {
        return _batchAttestationDigest(root, count, schemaVersion, deadline);
    }

    /// @notice A stored batch. Reverts `UnknownBatch` for an id that was never issued.
    function getBatch(uint256 batchId) external view returns (Batch memory) {
        if (batchId == 0 || batchId > batchCount) revert UnknownBatch(batchId);
        return _batches[batchId];
    }

    /* ------------------------------ administration ------------------------------ */

    /// @notice Halt both anchoring functions. Every read keeps working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    /// @notice Mark a batch void, so `verifyInclusion` and `verifyReceipt` return false for it.
    /// @dev Incident response. The call names the root it expects to void and fails loudly
    ///      on a mismatch, so a stale or mistyped batch id never voids the wrong batch. The
    ///      root (and, on the direct path, the run id) stays spent: a voided batch cannot be
    ///      re-anchored. Works while paused.
    function voidBatch(uint256 batchId, bytes32 expectedRoot, string calldata reason) external onlyOwner {
        if (batchId == 0 || batchId > batchCount) revert UnknownBatch(batchId);
        Batch storage batch = _batches[batchId];
        bytes32 stored = batch.root;
        if (stored != expectedRoot) revert VoidTargetMismatch(stored, expectedRoot);
        if (batch.voided) revert BatchAlreadyVoided(batchId);

        batch.voided = true;
        emit BatchVoided(batchId, stored, reason);
    }

    /// @notice Rotate the service key. Signatures by the previous key stop working at once.
    /// @dev Never the zero address and never the owner: a compromised service key must not
    ///      be able to administer the contract.
    function setServiceSigner(address newSigner) external onlyOwner {
        if (newSigner == address(0) || newSigner == owner()) revert InvalidServiceSigner();
        address previous = serviceSigner;
        serviceSigner = newSigner;
        emit ServiceSignerUpdated(previous, newSigner);
    }

    /// @notice Allow or stop anchoring of a schema version. Existing batches are unaffected.
    function setSchemaVersionEnabled(uint16 version, bool enabled) external onlyOwner {
        schemaVersionEnabled[version] = enabled;
        emit SchemaVersionSet(version, enabled);
    }

    /// @notice Start a two-step ownership transfer. Never to the current service signer.
    function transferOwnership(address newOwner) public override onlyOwner {
        if (newOwner == serviceSigner) revert InvalidServiceSigner();
        super.transferOwnership(newOwner);
    }

    /// @notice Always reverts: incident response needs an owner.
    function renounceOwnership() public virtual override onlyOwner {
        revert RenounceDisabled();
    }

    /* --------------------------------- internals -------------------------------- */

    /// @dev Every ownership change (including `acceptOwnership`) lands here. Re-checking the
    ///      signer at this point closes the gap where the signer is rotated to the pending
    ///      owner between `transferOwnership` and `acceptOwnership`.
    function _transferOwnership(address newOwner) internal override {
        if (newOwner == serviceSigner) revert InvalidServiceSigner();
        super._transferOwnership(newOwner);
    }

    /// @dev Accepts a signature from the agent OR its principal. EOAs are checked with ECDSA
    ///      and deployed contract wallets with EIP-1271, through OpenZeppelin 5.4.0's
    ///      `SignatureChecker.isValidSignatureNow` (vendored as `SignatureCheckerParis`; see
    ///      that file for why). Any failure (malformed bytes, a reverting wallet, a wallet
    ///      that says no) is a plain `false`. An account with code (a contract wallet, or
    ///      an EIP-7702-delegated EOA) is checked only through EIP-1271, never by ECDSA.
    function _isValidAgentSignature(
        address agent,
        address principal,
        bytes32 digest,
        bytes calldata signature
    ) internal view returns (bool) {
        if (SignatureCheckerParis.isValidSignatureNow(agent, digest, signature)) return true;
        return principal != agent && SignatureCheckerParis.isValidSignatureNow(principal, digest, signature);
    }

    /// @dev Field sanity, schema version, deadline window and replay, in that order.
    ///      Returns the receipt's leaf.
    function _checkReceipt(Receipt calldata receipt, uint64 deadline) private view returns (bytes32 leaf) {
        if (
            receipt.runId == bytes32(0) ||
            receipt.manifestHash == bytes32(0) ||
            receipt.agent == address(0) ||
            receipt.principal == address(0)
        ) revert InvalidReceipt();
        _checkSchemaVersion(receipt.schemaVersion);
        _checkDeadline(deadline);

        uint256 existing = batchIdOfRun[receipt.runId];
        if (existing != 0) revert DuplicateRun(receipt.runId, existing);
        leaf = _leafHash(receipt);
        _checkRootUnused(leaf);
    }

    function _checkSchemaVersion(uint16 schemaVersion) private view {
        if (!schemaVersionEnabled[schemaVersion]) revert SchemaVersionDisabled(schemaVersion);
    }

    function _checkDeadline(uint64 deadline) private view {
        if (deadline < block.timestamp) revert ExpiredSignature(deadline);
        if (deadline > block.timestamp + MAX_DEADLINE_WINDOW) revert DeadlineTooDistant(deadline);
    }

    function _checkRootUnused(bytes32 root) private view {
        uint256 existing = batchIdOfRoot[root];
        if (existing != 0) revert RootAlreadyAttested(root, existing);
    }

    /// @dev ECDSA only: the service key is an EOA. Malformed or high-s signatures and a
    ///      wrong signer all revert `InvalidServiceSignature`, never an OpenZeppelin error.
    function _checkServiceSignature(bytes32 digest, bytes calldata signature) private view {
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(digest, signature);
        if (err != ECDSA.RecoverError.NoError || recovered != serviceSigner) revert InvalidServiceSignature();
    }

    function _recordBatch(bytes32 root, uint32 count, uint16 schemaVersion) private returns (uint256 batchId) {
        batchId = ++batchCount;
        address signer = serviceSigner;
        _batches[batchId] = Batch({
            root: root,
            count: count,
            schemaVersion: schemaVersion,
            voided: false,
            serviceSigner: signer,
            attestedAt: uint64(block.timestamp),
            blockNumber: uint64(block.number)
        });
        batchIdOfRoot[root] = batchId;
        emit BatchAttested(batchId, root, signer, count, schemaVersion);
    }

    function _leafHash(Receipt calldata receipt) private pure returns (bytes32) {
        return leafHash(receipt.runId, receipt.manifestHash, receipt.agent, receipt.principal);
    }

    function _receiptDigest(Receipt calldata receipt) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(
                abi.encode(
                    RECEIPT_TYPEHASH,
                    receipt.runId,
                    receipt.manifestHash,
                    receipt.agent,
                    receipt.principal,
                    receipt.schemaVersion
                )
            )
        );
    }

    function _serviceAttestationDigest(bytes32 digest, uint64 deadline) private view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(SERVICE_ATTESTATION_TYPEHASH, digest, deadline)));
    }

    function _batchAttestationDigest(
        bytes32 root,
        uint32 count,
        uint16 schemaVersion,
        uint64 deadline
    ) private view returns (bytes32) {
        return _hashTypedDataV4(
            keccak256(abi.encode(BATCH_ATTESTATION_TYPEHASH, root, count, schemaVersion, deadline))
        );
    }
}
