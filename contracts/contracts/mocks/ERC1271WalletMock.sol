// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @dev Test-only EIP-1271 contract wallet. In `Approve` mode it accepts a signature by its
///      `signer` key; in `Reject` mode it returns a non-magic value for everything; in
///      `Revert` mode it reverts. Never deployed outside tests.
contract ERC1271WalletMock is IERC1271 {
    enum Mode {
        Approve,
        Reject,
        Revert
    }

    address public immutable signer;
    Mode public mode;

    constructor(address signer_) {
        signer = signer_;
    }

    function setMode(Mode newMode) external {
        mode = newMode;
    }

    function isValidSignature(bytes32 hash, bytes calldata signature) external view returns (bytes4) {
        if (mode == Mode.Revert) revert("ERC1271WalletMock: revert");
        if (mode == Mode.Reject) return 0xffffffff;
        (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) return IERC1271.isValidSignature.selector;
        return 0xffffffff;
    }
}
