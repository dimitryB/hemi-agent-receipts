// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Test stand-in for Permit2, an EIP-3009 token and the x402 Permit2 proxy on a bare anvil.
/// A 0x44-byte call f(address owner, uint256 key) answers mapping[owner][key] at slot 0
/// (nonceBitmap / authorizationState). Any other call carries, after whatever call it looks
/// like, a spec [target, count, dataLength, topics..., data] whose offset is the input's last
/// word: target 0 emits that log here; another target is called with the spec (target 0), so a
/// log can come from a contract other than the one the transaction calls.
contract SettleStub {
    fallback() external {
        assembly {
            if eq(calldatasize(), 0x44) {
                mstore(0x00, calldataload(0x04))
                mstore(0x20, 0)
                let inner := keccak256(0x00, 0x40)
                mstore(0x00, calldataload(0x24))
                mstore(0x20, inner)
                mstore(0x00, sload(keccak256(0x00, 0x40)))
                return(0x00, 0x20)
            }
            let spec := calldataload(sub(calldatasize(), 0x20))
            let target := calldataload(spec)
            if target {
                let specLength := sub(sub(calldatasize(), 0x20), spec)
                mstore(0x00, 0)
                calldatacopy(0x04, spec, specLength)
                mstore(0x04, 0)
                mstore(add(0x04, specLength), 0x04)
                if iszero(call(gas(), target, 0, 0x00, add(0x24, specLength), 0, 0)) { revert(0, 0) }
                stop()
            }
            let count := calldataload(add(spec, 0x20))
            let len := calldataload(add(spec, 0x40))
            let t := add(spec, 0x60)
            calldatacopy(0x00, add(t, mul(count, 0x20)), len)
            switch count
            case 1 { log1(0x00, len, calldataload(t)) }
            case 2 { log2(0x00, len, calldataload(t), calldataload(add(t, 0x20))) }
            case 3 { log3(0x00, len, calldataload(t), calldataload(add(t, 0x20)), calldataload(add(t, 0x40))) }
            default { revert(0, 0) }
            stop()
        }
    }
}
