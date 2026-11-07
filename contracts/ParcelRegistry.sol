// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {RoleManager} from "./RoleManager.sol";

/**
 * @title ParcelRegistry
 * @notice Canonical ownership record ("Record of Rights" / Fard) for land parcels.
 *
 *  - A parcel key is derived deterministically from (district, mouza, khasra) so the
 *    same physical parcel can NEVER be registered twice: the key collides and reverts.
 *  - Registration needs two different officials (Patwari proposes, Registrar approves):
 *    separation of duties against single-insider fraud.
 *  - Ownership can only be changed by two modules: TransferManager (voluntary sale)
 *    and DisputeRegistry (court decree). Nobody - not even the admin - can edit an
 *    owner directly.
 *  - Documents (scanned deed, mutation, map) live off-chain (IPFS / department DMS);
 *    only their SHA-256/keccak hash is anchored here.
 */
contract ParcelRegistry is Pausable {
    enum Status { None, Pending, Active, Frozen }

    struct Parcel {
        bytes32 ownerId;     // identity commitment from RoleManager
        bytes32 docHash;     // hash of off-chain document bundle (latest)
        uint64  areaSqFt;
        uint64  updatedAt;
        uint32  version;     // increments on every ownership change
        Status  status;
        address proposedBy;  // Patwari who proposed (for separation-of-duties)
    }

    RoleManager public immutable roles;
    address public transferManager;
    address public disputeRegistry;
    bool    public modulesLocked;

    mapping(bytes32 => Parcel) private _parcels;
    uint256 public activeParcelCount;

    // --------------------------------------------------------------- events
    event ModulesSet(address indexed transferManager, address indexed disputeRegistry);
    event ParcelProposed(bytes32 indexed parcelId, bytes32 indexed ownerId, address indexed patwari, uint64 areaSqFt, bytes32 docHash);
    event ParcelApproved(bytes32 indexed parcelId, address indexed registrar);
    event ParcelRejected(bytes32 indexed parcelId, address indexed registrar, bytes32 reasonHash);
    event OwnershipChanged(bytes32 indexed parcelId, bytes32 indexed fromId, bytes32 indexed toId, uint32 version, bytes32 docHash, address module);
    event FreezeStatusChanged(bytes32 indexed parcelId, bool frozen);

    // --------------------------------------------------------------- errors
    error NotRole(bytes32 role);
    error NotModule();
    error ModulesAreLocked();
    error DuplicateParcel(bytes32 parcelId);
    error InvalidStatus(bytes32 parcelId, Status status);
    error SameOfficial();
    error ZeroValue();

    modifier onlyRoleIn(bytes32 role) {
        if (!roles.hasRole(role, msg.sender)) revert NotRole(role);
        _;
    }

    modifier onlyAdmin() {
        if (!roles.hasRole(roles.DEFAULT_ADMIN_ROLE(), msg.sender)) revert NotRole(bytes32(0));
        _;
    }

    constructor(RoleManager roles_) {
        roles = roles_;
    }

    // ------------------------------------------------------- governance
    /// @notice Wire the two modules allowed to mutate ownership. Can be locked forever.
    function setModules(address transferManager_, address disputeRegistry_) external onlyAdmin {
        if (modulesLocked) revert ModulesAreLocked();
        if (transferManager_ == address(0) || disputeRegistry_ == address(0)) revert ZeroValue();
        transferManager = transferManager_;
        disputeRegistry = disputeRegistry_;
        emit ModulesSet(transferManager_, disputeRegistry_);
    }

    function lockModules() external onlyAdmin {
        modulesLocked = true;
    }

    function pause() external onlyAdmin { _pause(); }
    function unpause() external onlyAdmin { _unpause(); }

    // ------------------------------------------------------- registration
    /// @notice Deterministic id: same (district, mouza, khasra) => same id => no duplicates.
    function parcelKey(uint16 districtCode, uint32 mouzaCode, string calldata khasraNo) public pure returns (bytes32) {
        return keccak256(abi.encode(districtCode, mouzaCode, khasraNo));
    }

    function proposeParcel(bytes32 parcelId, bytes32 ownerId, uint64 areaSqFt, bytes32 docHash)
        external
        whenNotPaused
        onlyRoleIn(roles.PATWARI_ROLE())
    {
        if (ownerId == bytes32(0) || areaSqFt == 0 || docHash == bytes32(0)) revert ZeroValue();
        if (_parcels[parcelId].status != Status.None) revert DuplicateParcel(parcelId);

        _parcels[parcelId] = Parcel({
            ownerId: ownerId,
            docHash: docHash,
            areaSqFt: areaSqFt,
            updatedAt: uint64(block.timestamp),
            version: 0,
            status: Status.Pending,
            proposedBy: msg.sender
        });
        emit ParcelProposed(parcelId, ownerId, msg.sender, areaSqFt, docHash);
    }

    function approveParcel(bytes32 parcelId) external whenNotPaused onlyRoleIn(roles.REGISTRAR_ROLE()) {
        Parcel storage p = _parcels[parcelId];
        if (p.status != Status.Pending) revert InvalidStatus(parcelId, p.status);
        if (p.proposedBy == msg.sender) revert SameOfficial();
        p.status = Status.Active;
        p.version = 1;
        p.updatedAt = uint64(block.timestamp);
        activeParcelCount += 1;
        emit ParcelApproved(parcelId, msg.sender);
    }

    function rejectParcel(bytes32 parcelId, bytes32 reasonHash) external whenNotPaused onlyRoleIn(roles.REGISTRAR_ROLE()) {
        Parcel storage p = _parcels[parcelId];
        if (p.status != Status.Pending) revert InvalidStatus(parcelId, p.status);
        delete _parcels[parcelId];
        emit ParcelRejected(parcelId, msg.sender, reasonHash);
    }

    // ------------------------------------------------- module-only mutations
    function transferOwnership(bytes32 parcelId, bytes32 newOwnerId, bytes32 docHash) external whenNotPaused {
        if (msg.sender != transferManager) revert NotModule();
        Parcel storage p = _parcels[parcelId];
        if (p.status != Status.Active) revert InvalidStatus(parcelId, p.status);
        _changeOwner(parcelId, p, newOwnerId, docHash);
    }

    /// @notice Court decree may correct ownership even while the parcel is frozen.
    function courtOrderedTransfer(bytes32 parcelId, bytes32 newOwnerId, bytes32 orderHash) external whenNotPaused {
        if (msg.sender != disputeRegistry) revert NotModule();
        Parcel storage p = _parcels[parcelId];
        if (p.status != Status.Active && p.status != Status.Frozen) revert InvalidStatus(parcelId, p.status);
        _changeOwner(parcelId, p, newOwnerId, orderHash);
    }

    function setFrozen(bytes32 parcelId, bool frozen) external whenNotPaused {
        if (msg.sender != disputeRegistry) revert NotModule();
        Parcel storage p = _parcels[parcelId];
        if (frozen) {
            if (p.status != Status.Active) revert InvalidStatus(parcelId, p.status);
            p.status = Status.Frozen;
        } else {
            if (p.status != Status.Frozen) revert InvalidStatus(parcelId, p.status);
            p.status = Status.Active;
        }
        p.updatedAt = uint64(block.timestamp);
        emit FreezeStatusChanged(parcelId, frozen);
    }

    function _changeOwner(bytes32 parcelId, Parcel storage p, bytes32 newOwnerId, bytes32 docHash) private {
        if (newOwnerId == bytes32(0) || docHash == bytes32(0)) revert ZeroValue();
        bytes32 from = p.ownerId;
        p.ownerId = newOwnerId;
        p.docHash = docHash;
        p.version += 1;
        p.updatedAt = uint64(block.timestamp);
        emit OwnershipChanged(parcelId, from, newOwnerId, p.version, docHash, msg.sender);
    }

    // --------------------------------------------------------------- views
    function getParcel(bytes32 parcelId) external view returns (Parcel memory) {
        return _parcels[parcelId];
    }

    function ownerOf(bytes32 parcelId) external view returns (bytes32) {
        return _parcels[parcelId].ownerId;
    }

    function statusOf(bytes32 parcelId) external view returns (Status) {
        return _parcels[parcelId].status;
    }

    /// @notice What a bank calls: "does identity X own active parcel P right now?"
    function verifyOwnership(bytes32 parcelId, bytes32 claimedOwnerId) external view returns (bool owns, Status status, uint32 version) {
        Parcel storage p = _parcels[parcelId];
        return (p.ownerId == claimedOwnerId && p.status == Status.Active, p.status, p.version);
    }
}
