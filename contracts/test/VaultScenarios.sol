// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {StockRunVault} from "../src/StockRunVault.sol";
import {ITapeOutCircuits, IERC20Min} from "../src/interfaces/ITapeOutCircuits.sol";
import {MockToken} from "./mocks/MockToken.sol";

/// Vault scenarios and attack tests, written once. They run against two backends:
/// MockCircuits (StockRunVault.t.sol, offline) and the real taped-out circuits on an X Layer fork
/// (fork/StockRunVault.fork.t.sol). Each test names the design rule (CLAUDE.md) it protects.
abstract contract VaultScenarios is Test {
    MockToken token; StockRunVault vault;
    ITapeOutCircuits circuits; uint256 restockId; uint256 pickupId; uint256 deliveryId;

    address owner = makeAddr("owner"); address agent = makeAddr("agent"); address checker = makeAddr("checkService");
    address rider = makeAddr("logisticsCompany"); address payout = makeAddr("supplierOffRamp"); address stranger = makeAddr("stranger");
    bytes32 constant SUP = keccak256("mile12-wholesaler-1");
    uint256 constant UNIT = 5_000e6; // circuit money unit in token units (demo: 6-decimal token, 1 token = ₦1)

    /// Backends set `circuits` and the three ids, then call this.
    function _setUpVault() internal {
        token = new MockToken();
        vault = _newVault(restockId, pickupId, deliveryId);
        token.mint(owner, 1_000 * UNIT);
        vm.startPrank(owner); token.approve(address(vault), type(uint256).max); vault.deposit(500 * UNIT);
        vault.queueSupplier(SUP, 1, payout); vm.stopPrank();
        vm.warp(block.timestamp + 1 days); vault.applySupplier(SUP);
    }

    /// `rider` in these tests is a logistics company the owner picked at shop set-up (no bond).
    function _newVault(uint256 r, uint256 p, uint256 d) internal returns (StockRunVault) {
        address[] memory carriers = new address[](1); carriers[0] = rider;
        return new StockRunVault(IERC20Min(address(token)), circuits, r, p, d, UNIT, owner, agent, checker, 100 * UNIT, 40 * UNIT, carriers);
    }

    function _propose(uint8 qty, uint256 price) internal returns (uint256) {
        vm.prank(agent); return vault.proposeOrder(SUP, qty, price, 0, 0, rider, UNIT);
    }

    function _pickedUp(uint8 qty, uint8 riderCount, uint8 aiCount) internal returns (uint256 id) {
        id = _propose(qty, UNIT);
        vm.prank(rider); vault.riderPickup(id, true, riderCount);
        vm.prank(checker); vault.attestPickup(id, aiCount, false);
        vault.settlePickup(id);
    }

    function _status(uint256 id) internal view returns (StockRunVault.Status s) {
        (, , , , , , , , s, , , , , , , , , , , , , , , ) = vault.orders(id);
    }

    function _free() internal view returns (uint256) {
        return token.balanceOf(address(vault)) - vault.locked();
    }

    // ================================================================ happy paths

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
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Delivered));
    }

    function test_fullPickup_whenCountsMatch() public {
        _pickedUp(10, 10, 10);
        assertEq(token.balanceOf(payout), 10 * UNIT);
    }

    function test_shortDelivery_withholdsFeeForOwner() public {
        uint256 id = _pickedUp(10, 10, 10);
        vm.prank(rider); vault.riderArrive(id, true);
        vm.prank(checker); vault.attestDelivery(id, 7, false);
        uint256 freeBefore = _free();
        vm.expectEmit(true, false, false, true); emit StockRunVault.DeliveryShort(id, 3, UNIT);
        vault.settleDelivery(id);
        assertEq(token.balanceOf(rider), 0, "logistics fee withheld");
        assertEq(_free() - freeBefore, UNIT, "the fee is the owner's again");
        assertEq(vault.locked(), 0);
    }

    // ================================================================ handlers: self-pickup and logistics companies

    function test_selfPickup_ownerCountPaysSupplier_noDeliveryStep() public {
        vm.prank(agent); uint256 id = vault.proposeOrder(SUP, 10, UNIT, 0, 0, owner, 0);
        vm.prank(owner); vault.riderPickup(id, true, 9);         // owner at the supplier: 9 good cartons
        vault.settlePickup(id);                                   // no photo needed: the owner's count stands
        assertEq(token.balanceOf(payout), 9 * UNIT, "supplier paid for what the owner took");
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Delivered), "nothing left to deliver");
        assertEq(vault.locked(), 0, "the 10th carton's money is free again");
    }

    function test_selfPickup_cannotCarryAFee() public {
        vm.prank(agent); vm.expectRevert(StockRunVault.SelfPickupHasNoFee.selector);
        vault.proposeOrder(SUP, 10, UNIT, 0, 0, owner, UNIT);
    }

    function test_strangerCannotBeTheHandler() public {
        vm.prank(agent); vm.expectRevert(StockRunVault.UntrustedHandler.selector);
        vault.proposeOrder(SUP, 10, UNIT, 0, 0, stranger, UNIT);
    }

    function test_logisticsCompany_countWithoutPhoto_paysSupplier() public {
        uint256 id = _propose(10, UNIT);
        vm.prank(rider); vault.riderPickup(id, true, 10);        // company's rider checked the 10 cartons
        vault.settlePickup(id);
        assertEq(token.balanceOf(payout), 10 * UNIT);
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.PickedUp), "delivery still to come");
    }

    function test_photoCountCanOnlyLowerThePayment() public {
        _pickedUp(10, 10, 8);
        assertEq(token.balanceOf(payout), 8 * UNIT);
    }

    function test_newLogisticsCompanyWaits24h_andRemovalHoldsItsPickups() public {
        address other = makeAddr("otherCompany");
        vm.prank(owner); vault.queueCarrier(other, true);
        vm.prank(agent); vm.expectRevert(StockRunVault.UntrustedHandler.selector);
        vault.proposeOrder(SUP, 5, UNIT, 0, 0, other, UNIT);
        vm.warp(block.timestamp + 1 days); vault.applyCarrier(other);
        vm.prank(agent); uint256 id = vault.proposeOrder(SUP, 5, UNIT, 0, 0, other, UNIT);
        vm.prank(other); vault.riderPickup(id, true, 5);
        vm.prank(owner); vault.queueCarrier(other, false);     // owner drops the company: immediate
        vm.expectEmit(true, false, false, true); emit StockRunVault.PickupHeld(id, 2);
        vault.settlePickup(id);
        assertEq(token.balanceOf(payout), 0, "no payment on a removed company's word");
    }

    function test_onlyOwnerChoosesLogisticsCompanies() public {
        vm.prank(agent); vm.expectRevert(StockRunVault.NotAuthorized.selector); vault.queueCarrier(stranger, true);
        vm.prank(owner); vm.expectRevert(StockRunVault.UntrustedHandler.selector); vault.queueCarrier(owner, true);
    }

    function test_ownerSilent_paysRiderAfterTimeout() public {
        uint256 id = _pickedUp(10, 10, 10);
        vm.prank(rider); vault.riderArrive(id, true);
        vm.prank(checker); vault.attestDelivery(id, 10, false);
        vm.expectEmit(true, false, false, true); emit StockRunVault.DeliveryHeld(id, 5);
        vault.settleDelivery(id); // owner has not answered yet: WAIT
        vm.warp(block.timestamp + 24 hours);
        uint256 before = token.balanceOf(rider);
        vault.settleDelivery(id);
        assertEq(token.balanceOf(rider) - before, UNIT, "auto-release after 24h");
    }

    // ================================================================ RestockGuard rules

    function test_agentCannotOverspend() public {
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(StockRunVault.Rejected.selector, uint8(2)));
        vault.proposeOrder(SUP, 200, UNIT, 0, 0, rider, UNIT); // 201 units > budget 100
    }

    function test_unknownSupplierRejected() public {
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(StockRunVault.Rejected.selector, uint8(1)));
        vault.proposeOrder(keccak256("stranger"), 5, UNIT, 0, 0, rider, UNIT);
    }

    function test_aboveLimitNeedsOwner() public {
        uint256 id = _propose(50, UNIT); // 51 units > limit 40, within budget
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.AwaitingOwner));
        vm.prank(owner); vault.approveOrder(id);
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Locked));
    }

    function test_ownerCategoryAndDistanceNeedOwner() public {
        vm.startPrank(agent);
        uint256 a = vault.proposeOrder(SUP, 5, UNIT, 6, 0, rider, UNIT); // cat 6
        uint256 b = vault.proposeOrder(SUP, 5, UNIT, 0, 3, rider, UNIT); // > 10 km
        vm.stopPrank();
        assertEq(uint8(_status(a)), uint8(StockRunVault.Status.AwaitingOwner));
        assertEq(uint8(_status(b)), uint8(StockRunVault.Status.AwaitingOwner));
    }

    /// Rule 6: owner approval clears "ask owner" but never "reject".
    function test_rule6_ownerApprovalNeverOverridesBudget() public {
        uint256 id = _propose(50, UNIT);                    // ASK_OWNER (above limit)
        vm.prank(owner); vault.setWeeklyBudget(30 * UNIT);  // budget drops below the order
        vm.prank(owner); vm.expectRevert(abi.encodeWithSelector(StockRunVault.Rejected.selector, uint8(2)));
        vault.approveOrder(id);
    }

    function test_rule6_ownerApprovalNeverOverridesBlockedSupplier() public {
        uint256 id = _propose(50, UNIT);
        vm.startPrank(owner);
        vault.queueSupplier(SUP, 3, address(0)); // blocking is immediate
        vm.expectRevert(abi.encodeWithSelector(StockRunVault.Rejected.selector, uint8(1)));
        vault.approveOrder(id);
        vm.stopPrank();
    }

    // ================================================================ rule 1: the AI never moves money

    function test_rule1_agentCannotChooseWherePaymentGoes() public {
        _pickedUp(10, 10, 10); // proposeOrder has no payout parameter: it comes from the owner's registry
        assertEq(token.balanceOf(payout), 10 * UNIT, "paid to the owner-registered address");
        assertEq(token.balanceOf(agent), 0);
    }

    function test_rule1_payoutChangeIsDelayed() public {
        vm.prank(owner); vault.queueSupplier(SUP, 1, stranger);
        uint256 id = _propose(5, UNIT); // still the old payout until the delay passes
        vm.prank(rider); vault.riderPickup(id, true, 5);
        vm.prank(checker); vault.attestPickup(id, 5, false);
        vault.settlePickup(id);
        assertEq(token.balanceOf(payout), 5 * UNIT);
        assertEq(token.balanceOf(stranger), 0);
    }

    function test_rule1_approvedSupplierNeedsPayout() public {
        vm.prank(owner); vm.expectRevert(StockRunVault.NoPayout.selector);
        vault.queueSupplier(keccak256("new"), 1, address(0));
    }

    function test_rule1_agentCannotSubmitEvidenceOrApprove() public {
        uint256 id = _propose(10, UNIT);
        vm.startPrank(agent);
        vm.expectRevert(StockRunVault.NotAuthorized.selector); vault.attestPickup(id, 10, false);
        vm.expectRevert(StockRunVault.NotAuthorized.selector); vault.riderPickup(id, true, 10);
        vm.expectRevert(StockRunVault.NotAuthorized.selector); vault.approveOrder(id);
        vm.expectRevert(StockRunVault.NotAuthorized.selector); vault.withdraw(1);
        vm.stopPrank();
    }

    // ================================================================ rule 2: the vault builds every input

    function test_rule2_orderTooLargeForCircuitIsRefused() public {
        vm.prank(owner); vault.setWeeklyBudget(1_000 * UNIT);
        // 300 units would be capped to 255 vs a capped budget; the vault must refuse instead.
        vm.prank(agent); vm.expectRevert(StockRunVault.OrderTooLarge.selector);
        vault.proposeOrder(SUP, 255, 2 * UNIT, 0, 0, rider, UNIT);
    }

    function test_rule2_roundingNeverOverstatesBudget() public {
        vm.prank(owner); vault.setWeeklyBudget(10 * UNIT + UNIT / 2);   // 10.5 units left
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(StockRunVault.Rejected.selector, uint8(2)));
        vault.proposeOrder(SUP, 10, UNIT, 0, 0, rider, (UNIT * 8) / 10); // 10.8 units: over budget
    }

    function test_rule2_settleNeedsTheHandlersCount() public {
        uint256 id = _propose(10, UNIT);
        vm.expectRevert(StockRunVault.BadStatus.selector); vault.settlePickup(id);
        vm.prank(checker); vault.attestPickup(id, 10, false);    // a photo alone never pays
        vm.expectRevert(StockRunVault.BadStatus.selector); vault.settlePickup(id);
    }

    function test_rule2_onlyAssignedRiderReports() public {
        uint256 id = _propose(10, UNIT);
        vm.prank(stranger); vm.expectRevert(StockRunVault.NotAuthorized.selector); vault.riderPickup(id, true, 10);
    }

    // ================================================================ rule 3: two handovers, two checks

    function test_rule3_inflatedRiderCount_paysMinimum() public {
        _pickedUp(20, 25, 18);
        assertEq(token.balanceOf(payout), 18 * UNIT, "min(ai, rider, ordered)");
    }

    function test_rule3_bothInflated_capsAtOrdered() public {
        _pickedUp(20, 30, 30);
        assertEq(token.balanceOf(payout), 20 * UNIT);
    }

    function test_rule3_notAtSupplier_holds_thenResubmit() public {
        uint256 id = _propose(10, UNIT);
        vm.prank(rider); vault.riderPickup(id, false, 10);
        vm.prank(checker); vault.attestPickup(id, 10, false);
        vm.expectEmit(true, false, false, true); emit StockRunVault.PickupHeld(id, 1);
        vault.settlePickup(id);
        assertEq(token.balanceOf(payout), 0);
        vm.prank(rider); vault.riderPickup(id, true, 10);
        vault.settlePickup(id);
        assertEq(token.balanceOf(payout), 10 * UNIT);
    }


    function test_rule3_damage_holds() public {
        uint256 id = _propose(10, UNIT);
        vm.prank(rider); vault.riderPickup(id, true, 10);
        vm.prank(checker); vault.attestPickup(id, 10, true);
        vm.expectEmit(true, false, false, true); emit StockRunVault.PickupHeld(id, 3);
        vault.settlePickup(id);
    }

    function test_rule3_noDoubleSettlement() public {
        uint256 id = _pickedUp(10, 10, 10);
        vm.expectRevert(StockRunVault.BadStatus.selector); vault.settlePickup(id);
        vm.prank(rider); vault.riderArrive(id, true);
        vm.prank(checker); vault.attestDelivery(id, 10, false);
        vm.prank(owner); vault.ownerConfirm(id, true, false);
        vault.settleDelivery(id);
        vm.expectRevert(StockRunVault.BadStatus.selector); vault.settleDelivery(id);
    }

    function test_rule3_ownerIssue_holds() public {
        uint256 id = _pickedUp(10, 10, 10);
        vm.prank(rider); vault.riderArrive(id, true);
        vm.prank(checker); vault.attestDelivery(id, 10, false);
        vm.prank(owner); vault.ownerConfirm(id, false, true);
        vm.expectEmit(true, false, false, true); emit StockRunVault.DeliveryHeld(id, 2);
        vault.settleDelivery(id);
    }

    // ================================================================ rule 5: if a circuit call fails, the order holds

    function test_rule5_brokenRestockCircuit_noOrder() public {
        vault = _newVault(999_999, pickupId, deliveryId);
        vm.prank(owner); vault.queueSupplier(SUP, 1, payout);
        vm.warp(block.timestamp + 1 days); vault.applySupplier(SUP);
        vm.prank(agent); vm.expectRevert(StockRunVault.CircuitFailed.selector);
        vault.proposeOrder(SUP, 5, UNIT, 0, 0, rider, UNIT);
    }

    function test_rule5_brokenPickupCircuit_noPayment() public {
        vault = _newVault(restockId, 999_999, deliveryId);
        token.mint(address(vault), 100 * UNIT);
        vm.prank(owner); vault.queueSupplier(SUP, 1, payout);
        vm.warp(block.timestamp + 1 days); vault.applySupplier(SUP);
        uint256 id = _propose(10, UNIT);
        vm.prank(rider); vault.riderPickup(id, true, 10);
        vm.prank(checker); vault.attestPickup(id, 10, false);
        vm.expectRevert(StockRunVault.CircuitFailed.selector); vault.settlePickup(id);
        assertEq(token.balanceOf(payout), 0, "never pay by default");
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Locked), "order holds");
    }

    // ================================================================ owner funds

    function test_ownerCannotWithdrawLockedFunds() public {
        _propose(10, UNIT);
        uint256 free = _free();
        vm.startPrank(owner);
        vm.expectRevert(bytes("locked")); vault.withdraw(free + 1);
        vault.withdraw(free);
        vm.stopPrank();
        assertEq(token.balanceOf(address(vault)), vault.locked());
    }

    function test_stalePickup_refundsLockedFunds() public {
        uint256 id = _propose(10, UNIT);
        vm.warp(block.timestamp + 48 hours);
        vault.refundStale(id);
        assertEq(vault.locked(), 0);
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Refunded));
    }
}
