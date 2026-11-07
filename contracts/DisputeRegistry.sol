// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RoleManager} from "./RoleManager.sol";
import {ParcelRegistry} from "./ParcelRegistry.sol";

/**
 * @title DisputeRegistry
 * @notice Courts freeze disputed parcels (stay order) and, when a decree is issued,
 *         correct ownership. This is the on-chain answer to "what happens when the
 *         data is wrong?": history is never rewritten, a new corrective entry is
 *         appended, signed by a court key and linked to the decree hash.
 */
contract DisputeRegistry {
    struct Case {
        bytes32 parcelId;
        bytes32 caseRefHash;   // hash of suit number + court
        address court;
        uint64  openedAt;
        uint64  closedAt;
        bool    open;
    }

    RoleManager public immutable roles;
    ParcelRegistry public immutable registry;

    uint256 public caseCount;
    mapping(uint256 => Case) private _cases;
    mapping(bytes32 => uint256) public openCaseCount; // parcel -> number of open cases

    event CaseOpened(uint256 indexed caseId, bytes32 indexed parcelId, address indexed court, bytes32 caseRefHash);
    event CaseResolved(uint256 indexed caseId, bytes32 indexed parcelId, bool ownershipChanged, bytes32 newOwnerId, bytes32 decreeHash);

    error NotCourt();
    error CaseNotOpen();
    error ZeroValue();

    constructor(RoleManager roles_, ParcelRegistry registry_) {
        roles = roles_;
        registry = registry_;
    }

    modifier onlyCourt() {
        if (!roles.hasRole(roles.COURT_ROLE(), msg.sender)) revert NotCourt();
        _;
    }

    function openCase(bytes32 parcelId, bytes32 caseRefHash) external onlyCourt returns (uint256 caseId) {
        if (caseRefHash == bytes32(0)) revert ZeroValue();
        caseId = ++caseCount;
        _cases[caseId] = Case(parcelId, caseRefHash, msg.sender, uint64(block.timestamp), 0, true);
        uint256 prev = openCaseCount[parcelId];
        openCaseCount[parcelId] = prev + 1;
        emit CaseOpened(caseId, parcelId, msg.sender, caseRefHash);
        if (prev == 0) {
            registry.setFrozen(parcelId, true); // reverts if parcel is not Active
        }
    }

    /**
     * @param ownershipChanged true if the decree declares a different owner.
     * @param newOwnerId identity commitment of the rightful owner (ignored if !ownershipChanged).
     * @param decreeHash hash of the signed decree document.
     */
    function resolveCase(uint256 caseId, bool ownershipChanged, bytes32 newOwnerId, bytes32 decreeHash) external onlyCourt {
        Case storage c = _cases[caseId];
        if (!c.open) revert CaseNotOpen();
        if (decreeHash == bytes32(0)) revert ZeroValue();

        c.open = false;
        c.closedAt = uint64(block.timestamp);
        uint256 remaining = openCaseCount[c.parcelId] - 1;
        openCaseCount[c.parcelId] = remaining;
        emit CaseResolved(caseId, c.parcelId, ownershipChanged, newOwnerId, decreeHash);

        if (ownershipChanged) {
            registry.courtOrderedTransfer(c.parcelId, newOwnerId, decreeHash);
        }
        if (remaining == 0) {
            registry.setFrozen(c.parcelId, false);
        }
    }

    function getCase(uint256 caseId) external view returns (Case memory) {
        return _cases[caseId];
    }
}
