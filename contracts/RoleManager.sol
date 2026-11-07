// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/**
 * @title RoleManager
 * @notice Single source of truth for institutional roles and citizen identities.
 *
 * Design decision: land is owned by an IDENTITY (a salted hash commitment of the
 * citizen's CNIC, issued after NADRA-style KYC), not by a raw wallet address.
 * A wallet is only the *current key* bound to that identity. This lets a citizen
 * who loses a phone/key recover access without anyone re-registering the land,
 * and it stops one person from holding many identities (Sybil resistance) because
 * each identity commitment can be bound to exactly one wallet at a time.
 *
 * No CNIC, name or address ever touches the chain: only keccak256(CNIC || salt).
 */
contract RoleManager is AccessControl {
    // ---------------------------------------------------------------- roles
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE"); // Sub-Registrar
    bytes32 public constant PATWARI_ROLE   = keccak256("PATWARI_ROLE");   // Revenue field officer
    bytes32 public constant BANK_ROLE      = keccak256("BANK_ROLE");      // SBP-licensed bank
    bytes32 public constant COURT_ROLE     = keccak256("COURT_ROLE");     // Civil court / Board of Revenue
    bytes32 public constant TAX_ROLE       = keccak256("TAX_ROLE");       // Excise & Taxation / FBR
    bytes32 public constant KYC_ROLE       = keccak256("KYC_ROLE");       // NADRA e-Sahulat style verifier

    /// @notice Time an old key has to object to a wallet recovery.
    uint64 public constant RECOVERY_DELAY = 2 days;

    struct Citizen {
        bytes32 idCommitment; // keccak256(CNIC || salt)
        bool verified;
        uint64 verifiedAt;
    }

    struct Recovery {
        address newWallet;
        uint64 executableAt;
    }

    mapping(address => Citizen) private _citizens;
    mapping(bytes32 => address) private _walletOf;     // identity  -> current wallet
    mapping(bytes32 => Recovery) private _recoveries;  // identity  -> pending recovery

    // --------------------------------------------------------------- events
    event CitizenVerified(address indexed wallet, bytes32 indexed idCommitment, address indexed verifier);
    event CitizenRevoked(address indexed wallet, bytes32 indexed idCommitment, address indexed verifier);
    event RecoveryRequested(bytes32 indexed idCommitment, address indexed oldWallet, address indexed newWallet, uint64 executableAt);
    event RecoveryCancelled(bytes32 indexed idCommitment, address indexed by);
    event RecoveryExecuted(bytes32 indexed idCommitment, address indexed oldWallet, address indexed newWallet);

    // --------------------------------------------------------------- errors
    error ZeroAddress();
    error ZeroCommitment();
    error WalletAlreadyBound(address wallet);
    error IdentityAlreadyBound(bytes32 idCommitment);
    error NotVerified(address wallet);
    error NoPendingRecovery();
    error RecoveryNotReady(uint64 executableAt);
    error NotAuthorised();

    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    // ------------------------------------------------------------ KYC flow
    /// @notice Bind a verified identity commitment to a wallet (one-to-one).
    function verifyCitizen(address wallet, bytes32 idCommitment) external onlyRole(KYC_ROLE) {
        if (wallet == address(0)) revert ZeroAddress();
        if (idCommitment == bytes32(0)) revert ZeroCommitment();
        if (_citizens[wallet].verified) revert WalletAlreadyBound(wallet);
        if (_walletOf[idCommitment] != address(0)) revert IdentityAlreadyBound(idCommitment);

        _citizens[wallet] = Citizen(idCommitment, true, uint64(block.timestamp));
        _walletOf[idCommitment] = wallet;
        emit CitizenVerified(wallet, idCommitment, msg.sender);
    }

    /// @notice Revoke a wallet (e.g., deceased, fraud). Land stays with the identity.
    function revokeCitizen(address wallet) external onlyRole(KYC_ROLE) {
        Citizen memory c = _citizens[wallet];
        if (!c.verified) revert NotVerified(wallet);
        delete _citizens[wallet];
        delete _walletOf[c.idCommitment];
        emit CitizenRevoked(wallet, c.idCommitment, msg.sender);
    }

    // ------------------------------------------------------- key recovery
    /**
     * @notice Start moving an identity to a new wallet after offline biometric
     *         re-verification. Executable only after RECOVERY_DELAY so that the
     *         genuine owner (if they still hold the old key) can cancel an
     *         insider attempt to hijack their identity.
     */
    function requestRecovery(bytes32 idCommitment, address newWallet) external onlyRole(KYC_ROLE) {
        if (newWallet == address(0)) revert ZeroAddress();
        if (_citizens[newWallet].verified) revert WalletAlreadyBound(newWallet);
        address oldWallet = _walletOf[idCommitment];
        if (oldWallet == address(0)) revert NotVerified(oldWallet);

        uint64 at = uint64(block.timestamp) + RECOVERY_DELAY;
        _recoveries[idCommitment] = Recovery(newWallet, at);
        emit RecoveryRequested(idCommitment, oldWallet, newWallet, at);
    }

    /// @notice The current wallet holder, or any KYC officer, can cancel.
    function cancelRecovery(bytes32 idCommitment) external {
        if (_recoveries[idCommitment].newWallet == address(0)) revert NoPendingRecovery();
        if (msg.sender != _walletOf[idCommitment] && !hasRole(KYC_ROLE, msg.sender)) revert NotAuthorised();
        delete _recoveries[idCommitment];
        emit RecoveryCancelled(idCommitment, msg.sender);
    }

    function executeRecovery(bytes32 idCommitment) external onlyRole(KYC_ROLE) {
        Recovery memory r = _recoveries[idCommitment];
        if (r.newWallet == address(0)) revert NoPendingRecovery();
        if (block.timestamp < r.executableAt) revert RecoveryNotReady(r.executableAt);
        if (_citizens[r.newWallet].verified) revert WalletAlreadyBound(r.newWallet);

        address oldWallet = _walletOf[idCommitment];
        delete _recoveries[idCommitment];
        delete _citizens[oldWallet];
        _citizens[r.newWallet] = Citizen(idCommitment, true, uint64(block.timestamp));
        _walletOf[idCommitment] = r.newWallet;
        emit RecoveryExecuted(idCommitment, oldWallet, r.newWallet);
    }

    // --------------------------------------------------------------- views
    function isVerified(address wallet) external view returns (bool) {
        return _citizens[wallet].verified;
    }

    function idOf(address wallet) external view returns (bytes32) {
        return _citizens[wallet].idCommitment;
    }

    function walletOf(bytes32 idCommitment) external view returns (address) {
        return _walletOf[idCommitment];
    }

    function pendingRecovery(bytes32 idCommitment) external view returns (address newWallet, uint64 executableAt) {
        Recovery memory r = _recoveries[idCommitment];
        return (r.newWallet, r.executableAt);
    }
}
