// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal view of a TapeOut processor's circuits contract.
/// @dev Per TAP-02 §6: `eval(uint256,bytes) returns (bytes)`, selector 0x934d06ea. Bits are LSB-first (§5).
///      Verified on BNB only; confirm on an X Layer fork (docs/TAPEOUT_NOTES.md, "Fork check").
interface ITapeOutCircuits {
    function eval(uint256 circuitId, bytes calldata input) external view returns (bytes memory output);
}

interface IERC20Min {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
}
