// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal view of a TapeOut processor's circuits contract.
/// @dev VERIFY against the official ABI before deploying. One hackathon project reports
///      `eval(uint256,bytes)` with selector 0x934d06ea. Return type and bit order are unconfirmed.
interface ITapeOutCircuits {
    function eval(uint256 circuitId, bytes calldata input) external view returns (bytes memory output);
}

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
