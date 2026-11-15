// SPDX-License-Identifier: MIT
// Adapted from OpenZeppelin Contracts v5.4.0 (utils/cryptography/SignatureChecker.sol).
pragma solidity 0.8.28;

import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";

/// @dev The two functions of OpenZeppelin 5.4.0's `SignatureChecker` that ReceiptRegistry
///      uses, copied verbatim. They are vendored for one reason: OZ 5.4.0's
///      SignatureChecker.sol also carries an ERC-7913 overload that imports `Bytes.sol`,
///      whose `slice` uses the Cancun-only `mcopy` opcode, so the file does not compile for
///      the `paris` EVM target this project deploys with. The address-signer path below
///      (ECDSA for an account without code, ERC-1271 for one with code) is unchanged.
library SignatureCheckerParis {
    /// @dev Checks if a signature is valid for a given signer and data hash. If the signer has
    ///      code, the signature is validated against it using ERC-1271, otherwise it's
    ///      validated using `ECDSA.recover`.
    ///
    ///      NOTE: Unlike ECDSA signatures, contract signatures are revocable, and the outcome of
    ///      this function can thus change through time.
    function isValidSignatureNow(address signer, bytes32 hash, bytes memory signature) internal view returns (bool) {
        if (signer.code.length == 0) {
            (address recovered, ECDSA.RecoverError err, ) = ECDSA.tryRecover(hash, signature);
            return err == ECDSA.RecoverError.NoError && recovered == signer;
        } else {
            return isValidERC1271SignatureNow(signer, hash, signature);
        }
    }

    /// @dev Checks if a signature is valid for a given signer and data hash. The signature is
    ///      validated against the signer smart contract using ERC-1271.
    function isValidERC1271SignatureNow(
        address signer,
        bytes32 hash,
        bytes memory signature
    ) internal view returns (bool) {
        (bool success, bytes memory result) = signer.staticcall(
            abi.encodeCall(IERC1271.isValidSignature, (hash, signature))
        );
        return (success &&
            result.length >= 32 &&
            abi.decode(result, (bytes32)) == bytes32(IERC1271.isValidSignature.selector));
    }
}
