// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {RoleManager} from "./RoleManager.sol";
import {ParcelRegistry} from "./ParcelRegistry.sol";
import {LienRegistry} from "./LienRegistry.sol";

/**
 * @title TransferManager
 * @notice State machine for a voluntary sale (Intiqal / mutation):
 *
 *   None -> Initiated --(buyer)--> Accepted --(tax)--> TaxCleared --(registrar, after notice)--> Completed
 *              |                      |                    |
 *              +------ Cancelled <----+   Rejected <-------+  (registrar can reject any open step)
 *
 *  Safety properties enforced on-chain:
 *   - only the current owner's bound wallet can initiate;
 *   - one open transfer per parcel (prevents double-selling / front-running a sale);
 *   - no completion while a lien is active or the parcel is frozen by a court;
 *   - a public-notice window (default 3 days) must elapse for objections;
 *   - the parcel version is pinned at initiation, so if ownership changed meanwhile
 *     (e.g., by court decree) the stale transfer cannot complete.
 */
contract TransferManager {
    enum State { None, Initiated, Accepted, TaxCleared, Completed, Cancelled, Rejected }

    struct Transfer {
        bytes32 parcelId;
        bytes32 sellerId;
        bytes32 buyerId;
        bytes32 deedHash;        // hash of signed sale deed (off-chain)
        bytes32 taxReceiptHash;  // hash of stamp-duty / CVT / 236C-236K receipt
        uint128 pricePkr;
        uint64  noticeEndsAt;
        uint32  parcelVersion;
        State   state;
    }

    RoleManager public immutable roles;
    ParcelRegistry public immutable registry;
    LienRegistry public immutable liens;
    uint64 public immutable noticePeriod;

    uint256 public transferCount;
    mapping(uint256 => Transfer) private _transfers;
    mapping(bytes32 => uint256) public openTransferOf; // parcel -> open transfer id (0 = none)

    event TransferInitiated(uint256 indexed id, bytes32 indexed parcelId, bytes32 indexed buyerId, bytes32 sellerId, uint128 pricePkr, bytes32 deedHash);
    event TransferAccepted(uint256 indexed id, uint64 noticeEndsAt);
    event TaxCleared(uint256 indexed id, bytes32 receiptHash, address indexed taxOfficer);
    event TransferCompleted(uint256 indexed id, bytes32 indexed parcelId, address indexed registrar);
    event TransferCancelled(uint256 indexed id, address indexed by);
    event TransferRejected(uint256 indexed id, address indexed registrar, bytes32 reasonHash);

    error NotOwner();
    error NotBuyer();
    error NotRole(bytes32 role);
    error BadState(State expected, State actual);
    error ParcelBusy(uint256 openTransferId);
    error ParcelNotActive();
    error ParcelEncumbered();
    error NoticePeriodRunning(uint64 endsAt);
    error StaleParcelVersion();
    error InvalidBuyer();
    error ZeroValue();
    error NotParty();

    constructor(RoleManager roles_, ParcelRegistry registry_, LienRegistry liens_, uint64 noticePeriod_) {
        roles = roles_;
        registry = registry_;
        liens = liens_;
        noticePeriod = noticePeriod_;
    }

    modifier onlyRoleIn(bytes32 role) {
        if (!roles.hasRole(role, msg.sender)) revert NotRole(role);
        _;
    }

    // ------------------------------------------------------------ seller
    function initiate(bytes32 parcelId, bytes32 buyerId, uint128 pricePkr, bytes32 deedHash) external returns (uint256 id) {
        ParcelRegistry.Parcel memory p = registry.getParcel(parcelId);
        bytes32 sellerId = roles.idOf(msg.sender);
        if (sellerId == bytes32(0) || p.ownerId != sellerId) revert NotOwner();
        if (p.status != ParcelRegistry.Status.Active) revert ParcelNotActive();
        if (buyerId == bytes32(0) || buyerId == sellerId) revert InvalidBuyer();
        if (pricePkr == 0 || deedHash == bytes32(0)) revert ZeroValue();
        if (openTransferOf[parcelId] != 0) revert ParcelBusy(openTransferOf[parcelId]);
        if (liens.isEncumbered(parcelId)) revert ParcelEncumbered();

        id = ++transferCount;
        _transfers[id] = Transfer({
            parcelId: parcelId,
            sellerId: sellerId,
            buyerId: buyerId,
            deedHash: deedHash,
            taxReceiptHash: bytes32(0),
            pricePkr: pricePkr,
            noticeEndsAt: 0,
            parcelVersion: p.version,
            state: State.Initiated
        });
        openTransferOf[parcelId] = id;
        emit TransferInitiated(id, parcelId, buyerId, sellerId, pricePkr, deedHash);
    }

    // ------------------------------------------------------------- buyer
    function accept(uint256 id) external {
        Transfer storage t = _transfers[id];
        _expect(t, State.Initiated);
        if (roles.idOf(msg.sender) != t.buyerId) revert NotBuyer();
        t.state = State.Accepted;
        t.noticeEndsAt = uint64(block.timestamp) + noticePeriod;
        emit TransferAccepted(id, t.noticeEndsAt);
    }

    // ------------------------------------------------------- tax authority
    function clearTax(uint256 id, bytes32 receiptHash) external onlyRoleIn(roles.TAX_ROLE()) {
        Transfer storage t = _transfers[id];
        _expect(t, State.Accepted);
        if (receiptHash == bytes32(0)) revert ZeroValue();
        t.taxReceiptHash = receiptHash;
        t.state = State.TaxCleared;
        emit TaxCleared(id, receiptHash, msg.sender);
    }

    // ----------------------------------------------------------- registrar
    function approve(uint256 id) external onlyRoleIn(roles.REGISTRAR_ROLE()) {
        Transfer storage t = _transfers[id];
        _expect(t, State.TaxCleared);
        if (block.timestamp < t.noticeEndsAt) revert NoticePeriodRunning(t.noticeEndsAt);

        ParcelRegistry.Parcel memory p = registry.getParcel(t.parcelId);
        if (p.status != ParcelRegistry.Status.Active) revert ParcelNotActive();
        if (p.version != t.parcelVersion || p.ownerId != t.sellerId) revert StaleParcelVersion();
        if (liens.isEncumbered(t.parcelId)) revert ParcelEncumbered();

        // Effects before interaction (checks-effects-interactions)
        t.state = State.Completed;
        delete openTransferOf[t.parcelId];
        emit TransferCompleted(id, t.parcelId, msg.sender);

        registry.transferOwnership(t.parcelId, t.buyerId, t.deedHash);
    }

    function reject(uint256 id, bytes32 reasonHash) external onlyRoleIn(roles.REGISTRAR_ROLE()) {
        Transfer storage t = _transfers[id];
        if (t.state != State.Initiated && t.state != State.Accepted && t.state != State.TaxCleared) {
            revert BadState(State.TaxCleared, t.state);
        }
        t.state = State.Rejected;
        delete openTransferOf[t.parcelId];
        emit TransferRejected(id, msg.sender, reasonHash);
    }

    /// @notice Either party may walk away before tax is paid.
    function cancel(uint256 id) external {
        Transfer storage t = _transfers[id];
        if (t.state != State.Initiated && t.state != State.Accepted) revert BadState(State.Accepted, t.state);
        bytes32 caller = roles.idOf(msg.sender);
        if (caller == bytes32(0) || (caller != t.sellerId && caller != t.buyerId)) revert NotParty();
        t.state = State.Cancelled;
        delete openTransferOf[t.parcelId];
        emit TransferCancelled(id, msg.sender);
    }

    // --------------------------------------------------------------- views
    function getTransfer(uint256 id) external view returns (Transfer memory) {
        return _transfers[id];
    }

    function _expect(Transfer storage t, State s) private view {
        if (t.state != s) revert BadState(s, t.state);
    }
}
