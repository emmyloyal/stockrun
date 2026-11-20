// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StockRunVault} from "../src/StockRunVault.sol";
import {ITapeOutCircuits, IERC20Min} from "../src/interfaces/ITapeOutCircuits.sol";
import {MockCircuits} from "./mocks/MockCircuits.sol";

/// Exposes the vault's internal packing so it can be checked against the golden vectors
/// in circuits/test/circuits.test.ts (TAP-02 §5 layout, LSB-first).
contract VaultHarness is StockRunVault {
    constructor() StockRunVault(IERC20Min(address(1)), ITapeOutCircuits(address(2)), 1, 2, 3, 1, address(3), address(4), address(5), 0, 0, new address[](0)) {}

    function packRestock(uint256 total, uint256 budget, uint256 lim, uint256 sup, uint256 cat, uint256 dist, uint256 ok)
        external pure returns (bytes memory)
    {
        return _pack(_f(total, 8), _f(budget, 8), _f(lim, 8), _f(sup, 2), _f(cat, 3), _f(dist, 2), _f(ok, 1), _f(0, 2));
    }

    function packPickup(uint256 at, uint256 ordered, uint256 ai, uint256 rider, uint256 damage, uint256 bonded)
        external pure returns (bytes memory)
    {
        return _pack(_f(at, 1), _f(ordered, 8), _f(ai, 8), _f(rider, 8), _f(damage, 1), _f(bonded, 1), _f(0, 0), _f(0, 0));
    }

    function unpack3(bytes memory data, uint256 a, uint256 b, uint256 c) external pure returns (uint256[] memory) {
        return _unpack(data, _w3(a, b, c));
    }
}

contract PackingTest is Test {
    VaultHarness h;
    MockCircuits circuits;

    function setUp() public { h = new VaultHarness(); circuits = new MockCircuits(); }

    function test_restockGolden() public view {
        assertEq(h.packRestock(0x12, 0x34, 0x56, 1, 2, 3, 1), hex"123456e900");
    }

    function test_pickupGolden() public view {
        assertEq(h.packPickup(1, 20, 18, 19, 0, 1), hex"29242604");
    }

    function test_unpackGolden() public view {
        uint256[] memory v = h.unpack3(hex"4914", 2, 8, 3);
        assertEq(v[0], 1); assertEq(v[1], 18); assertEq(v[2], 5);
    }

    function test_unpackRejectsShortOutput() public {
        vm.expectRevert(StockRunVault.CircuitFailed.selector);
        h.unpack3(hex"49", 2, 8, 3);
    }

    /// Mock and vault agree end to end: 20 ordered, AI 18, rider 19 -> PAY_PART, 18, reason 5.
    function test_mockPickupGolden() public view {
        assertEq(circuits.eval(2, hex"29242604"), hex"4914");
    }
}
