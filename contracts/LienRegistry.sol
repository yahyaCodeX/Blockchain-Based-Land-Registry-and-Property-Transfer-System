// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RoleManager} from "./RoleManager.sol";
import {ParcelRegistry} from "./ParcelRegistry.sol";

/**
 * @title LienRegistry
 * @notice Banks record mortgages / charges against a parcel. While any lien is
 *         active, TransferManager refuses to complete a sale - the classic
 *         "sell a mortgaged plot to an unsuspecting buyer" fraud is blocked.
 *
 *         A lien needs BOTH parties: the owner first grants consent to a specific
 *         bank, then that bank registers it. Only the same bank can release it.
 */
contract LienRegistry {
    struct Lien {
        bytes32 parcelId;
        address bank;
        uint128 amountPkr;
        uint64  createdAt;
        bool    active;
        bytes32 agreementHash; // hash of off-chain loan agreement
    }

    RoleManager public immutable roles;
    ParcelRegistry public immutable registry;

    uint256 public lienCount;
    mapping(uint256 => Lien) private _liens;
    mapping(bytes32 => uint256) public activeLienCount;               // parcel -> #active liens
    mapping(bytes32 => mapping(address => bool)) public lienConsent;  // parcel -> bank -> consent

    event LienConsentGranted(bytes32 indexed parcelId, bytes32 indexed ownerId, address indexed bank);
    event LienRegistered(uint256 indexed lienId, bytes32 indexed parcelId, address indexed bank, uint128 amountPkr, bytes32 agreementHash);
    event LienReleased(uint256 indexed lienId, bytes32 indexed parcelId, address indexed bank);

    error NotOwner();
    error NotBank();
    error NoConsent();
    error ParcelNotActive();
    error NotLienHolder();
    error LienNotActive();
    error ZeroValue();

    constructor(RoleManager roles_, ParcelRegistry registry_) {
        roles = roles_;
        registry = registry_;
    }

    function grantLienConsent(bytes32 parcelId, address bank) external {
        bytes32 owner = registry.ownerOf(parcelId);
        if (owner == bytes32(0) || roles.idOf(msg.sender) != owner) revert NotOwner();
        if (!roles.hasRole(roles.BANK_ROLE(), bank)) revert NotBank();
        lienConsent[parcelId][bank] = true;
        emit LienConsentGranted(parcelId, owner, bank);
    }

    function registerLien(bytes32 parcelId, uint128 amountPkr, bytes32 agreementHash) external returns (uint256 lienId) {
        if (!roles.hasRole(roles.BANK_ROLE(), msg.sender)) revert NotBank();
        if (amountPkr == 0 || agreementHash == bytes32(0)) revert ZeroValue();
        if (!lienConsent[parcelId][msg.sender]) revert NoConsent();
        if (registry.statusOf(parcelId) != ParcelRegistry.Status.Active) revert ParcelNotActive();

        lienConsent[parcelId][msg.sender] = false; // consent is single-use
        lienId = ++lienCount;
        _liens[lienId] = Lien(parcelId, msg.sender, amountPkr, uint64(block.timestamp), true, agreementHash);
        activeLienCount[parcelId] += 1;
        emit LienRegistered(lienId, parcelId, msg.sender, amountPkr, agreementHash);
    }

    function releaseLien(uint256 lienId) external {
        Lien storage l = _liens[lienId];
        if (!l.active) revert LienNotActive();
        if (l.bank != msg.sender) revert NotLienHolder();
        l.active = false;
        activeLienCount[l.parcelId] -= 1;
        emit LienReleased(lienId, l.parcelId, msg.sender);
    }

    function getLien(uint256 lienId) external view returns (Lien memory) {
        return _liens[lienId];
    }

    function isEncumbered(bytes32 parcelId) external view returns (bool) {
        return activeLienCount[parcelId] > 0;
    }
}
