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

/// @notice TapeOut processor factory (X Layer 0x1f09DAeFA827f02CBb40967cc91b259763760761).
/// @dev Selectors match the deployed bytecode (createCPU 0x47f9b5fd). Since the factory was upgraded (impl
///      0x336e9F0F4c3fEe7C8c803377e4DEA00293f4ae2a), createCPU is NONPAYABLE and pulls `deployFee` in the BEM
///      ERC-20 (`bem()`, 8 decimals) via transferFrom. Fees are owner-settable: always read them live.
interface ITapeOutFactory {
    function createCPU(string calldata name, string calldata symbol, string calldata story, uint256 transistorSupply, uint256 mintPrice)
        external returns (address transistors, address circuits);
    function bem() external view returns (address);
    function MAX_MINT_PRICE() external view returns (uint256);
    function protocolFee() external view returns (uint256);
    function deployFee() external view returns (uint256);
    function isCPU(address circuits) external view returns (bool);
    function cpuCount() external view returns (uint256);
}

/// @notice A processor's circuits contract (ERC-721). TAP-02 §6; selectors match the deployed implementation.
interface ITapeOutProcessor is ITapeOutCircuits {
    function tapeout(bytes calldata netlist, uint32 nIn, uint32 nOut) external payable returns (uint256 id);
    function TAPEOUT_FEE() external view returns (uint256);
    function transistors() external view returns (address);
    function circuitInfo(uint256 id) external view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount);
    function netlist(uint256 id) external view returns (bytes memory);
    function nextId() external view returns (uint256);
    function ownerOf(uint256 id) external view returns (address);
}

/// @notice A processor's transistor tokens (ERC-1155). NAND = id 0, LATCH = id 1.
/// @dev Current implementation (beacon 0x41Cb2bfd..., impl 0x44Ebf334...): mint is NONPAYABLE and pulls
///      amount * mintPrice + protocolFee in BEM via transferFrom. Older processors used payable OKB mints.
interface ITapeOutTransistors {
    function mint(uint256 id, uint256 amount) external;
    function BEM() external view returns (address);
    function mintPrice() external view returns (uint256);
    function protocolFee() external view returns (uint256);
    function supplyCap() external view returns (uint256);
    function minted() external view returns (uint256);
    function balanceOf(address account, uint256 id) external view returns (uint256);
}
