// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/**
 * @title StateAnchor
 * @notice Deployed on a PUBLIC chain (e.g., Polygon PoS / Amoy testnet). Every N
 *         consortium blocks, the governance multisig posts the consortium block hash
 *         and a Merkle root of all parcel records. Anyone in the world can later prove
 *         that the consortium did not silently rewrite its history (it would break
 *         the chain of anchored roots), without the public chain learning any owner data.
 */
contract StateAnchor is Ownable {
    struct Checkpoint {
        uint64  consortiumBlock;
        uint64  anchoredAt;
        bytes32 blockHash;
        bytes32 parcelsMerkleRoot;
    }

    Checkpoint[] private _checkpoints;

    event Anchored(uint256 indexed index, uint64 consortiumBlock, bytes32 blockHash, bytes32 parcelsMerkleRoot);

    error NonMonotonic();

    constructor(address governance) Ownable(governance) {}

    function anchor(uint64 consortiumBlock, bytes32 blockHash, bytes32 parcelsMerkleRoot) external onlyOwner {
        uint256 n = _checkpoints.length;
        if (n > 0 && consortiumBlock <= _checkpoints[n - 1].consortiumBlock) revert NonMonotonic();
        _checkpoints.push(Checkpoint(consortiumBlock, uint64(block.timestamp), blockHash, parcelsMerkleRoot));
        emit Anchored(n, consortiumBlock, blockHash, parcelsMerkleRoot);
    }

    function checkpointCount() external view returns (uint256) {
        return _checkpoints.length;
    }

    function checkpoint(uint256 i) external view returns (Checkpoint memory) {
        return _checkpoints[i];
    }

    function latest() external view returns (Checkpoint memory) {
        return _checkpoints[_checkpoints.length - 1];
    }
}
