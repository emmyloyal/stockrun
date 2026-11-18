// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StockRunVault} from "../src/StockRunVault.sol";
import {ITapeOutCircuits, IERC20Min} from "../src/interfaces/ITapeOutCircuits.sol";
import {MockCircuits} from "./mocks/MockCircuits.sol";
import {MockToken} from "./mocks/MockToken.sol";

contract StockRunVaultTest is Test {
    MockToken token; MockCircuits circuits; StockRunVault vault;
    address owner = address(0xA11CE); address agent = address(0xA6E); address checker = address(0xC4EC);
    address rider = address(0xB1DE); address payout = address(0x0FF);
    bytes32 constant SUP = keccak256("mile12-wholesaler-1");
    uint256 constant UNIT = 5_000e6; // circuit money unit in token units (demo: 6-decimal token, 1 token = ₦1)

    function setUp() public {
        token = new MockToken(); circuits = new MockCircuits();
        vault = new StockRunVault(IERC20Min(address(token)), ITapeOutCircuits(address(circuits)), 1, 2, 3,
            UNIT, owner, agent, checker, 100 * UNIT, 40 * UNIT);
        token.mint(owner, 1_000 * UNIT); vm.startPrank(owner); token.approve(address(vault), type(uint256).max); vault.deposit(500 * UNIT);
        vault.queueSupplier(SUP, 1); vm.stopPrank();
        vm.warp(block.timestamp + 1 days); vault.applySupplier(SUP);
        token.mint(rider, 200 * UNIT); vm.startPrank(rider); token.approve(address(vault), type(uint256).max); vault.postBond(100 * UNIT); vm.stopPrank();
    }

    function _propose(uint8 qty, uint256 price) internal returns (uint256) {
        vm.prank(agent); return vault.proposeOrder(SUP, payout, qty, price, 0, 0, rider, UNIT);
    }

    function test_happyPath_partialPickup_thenDelivery() public {
        uint256 id = _propose(20, UNIT); // 20 units at ₦5,000 = 20 money units + 1 rider fee
        vm.prank(rider); vault.riderPickup(id, true, 18);
        vm.prank(checker); vault.attestPickup(id, 19, false);
        vault.settlePickup(id);
        assertEq(token.balanceOf(payout), 18 * UNIT, "supplier paid for 18");
        vm.prank(rider); vault.riderArrive(id, true);
        vm.prank(checker); vault.attestDelivery(id, 18, false);
        vm.prank(owner); vault.ownerConfirm(id, true, false);
        uint256 before = token.balanceOf(rider);
        vault.settleDelivery(id);
        assertEq(token.balanceOf(rider) - before, UNIT, "rider fee paid");
        assertEq(vault.locked(), 0);
    }

    function test_agentCannotOverspend() public {
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(StockRunVault.Rejected.selector, uint8(2)));
        vault.proposeOrder(SUP, payout, 200, UNIT, 0, 0, rider, UNIT); // 201 units > budget 100
    }

    function test_unknownSupplierRejected() public {
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(StockRunVault.Rejected.selector, uint8(1)));
        vault.proposeOrder(keccak256("stranger"), payout, 5, UNIT, 0, 0, rider, UNIT);
    }

    function test_aboveLimitNeedsOwner() public {
        uint256 id = _propose(50, UNIT); // 51 units > limit 40, within budget
        (, , , , , , , , StockRunVault.Status s, ) = _head(id);
        assertEq(uint8(s), uint8(StockRunVault.Status.AwaitingOwner));
        vm.prank(owner); vault.approveOrder(id);
        (, , , , , , , , s, ) = _head(id);
        assertEq(uint8(s), uint8(StockRunVault.Status.Locked));
    }

    function test_agentCannotSettleMoneyDirectly() public {
        uint256 id = _propose(10, UNIT);
        vm.prank(agent); vm.expectRevert(StockRunVault.NotAuthorized.selector);
        vault.attestPickup(id, 10, false);
    }

    function test_shortDeliveryCompensatesFromBond() public {
        uint256 id = _propose(10, UNIT);
        vm.prank(rider); vault.riderPickup(id, true, 10);
        vm.prank(checker); vault.attestPickup(id, 10, false);
        vault.settlePickup(id);
        vm.prank(rider); vault.riderArrive(id, true);
        vm.prank(checker); vault.attestDelivery(id, 7, false);
        uint256 bondBefore = vault.bond(rider);
        vault.settleDelivery(id);
        assertEq(bondBefore - vault.bond(rider), 3 * UNIT, "3 short units taken from bond");
    }

    // reads the first 10 fields of an order
    function _head(uint256 id) internal view returns (bytes32, address, address, uint8, uint8, uint8, uint256, uint256, StockRunVault.Status, uint64) {
        (bytes32 a, address b, address c, uint8 d, uint8 e, uint8 f, uint256 g, uint256 h, StockRunVault.Status i, uint64 j,,,,,,,,,,,,,,) = vault.orders(id);
        return (a, b, c, d, e, f, g, h, i, j);
    }
}
