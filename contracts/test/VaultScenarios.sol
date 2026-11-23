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
    address stockrunPayout = makeAddr("stockrunPayoutWallet"); // the vault's fixed default payout
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
        return new StockRunVault(IERC20Min(address(token)), circuits, r, p, d, UNIT, owner, agent, checker, 100 * UNIT, 40 * UNIT, carriers, stockrunPayout, 0, address(0), 0);
    }

    function _propose(uint8 qty, uint256 price) internal returns (uint256) {
        vm.prank(agent); return vault.proposeOrder(SUP, qty, price, 0, 0, rider);
    }

    function _pickedUp(uint8 qty, uint8 riderCount, uint8 aiCount) internal returns (uint256 id) {
        id = _propose(qty, UNIT);
        vm.prank(rider); vault.riderPickup(id, true, riderCount);
        vm.prank(checker); vault.attestPickup(id, aiCount, false);
        vault.settlePickup(id);
    }

    function _status(uint256 id) internal view returns (StockRunVault.Status s) {
        (, , , , , , , s, , , , , , , , , , , , , , , , , ) = vault.orders(id);
    }

    function _verdict(uint256 id) internal view returns (uint8 v, uint8 short_) {
        (, , , , , , , , , , , , , , , , , , , , , , , v, short_) = vault.orders(id);
    }

    /// Every token balance the vault could touch, plus its own accounting.
    function _balances() internal view returns (uint256[6] memory b) {
        b = [token.balanceOf(address(vault)), token.balanceOf(owner), token.balanceOf(rider),
             token.balanceOf(payout), vault.locked(), vault.spentThisWeek()];
    }

    /// Picked up by the logistics company, at the shop, counted: ready for settleDelivery.
    function _atShop(uint8 qty, uint8 deliveredCount, bool ownerOk) internal returns (uint256 id) {
        id = _pickedUp(qty, qty, qty);
        vm.prank(rider); vault.riderArrive(id, true);
        vm.prank(checker); vault.attestDelivery(id, deliveredCount, false);
        if (ownerOk) { vm.prank(owner); vault.ownerConfirm(id, true, false); }
    }

    function _free() internal view returns (uint256) {
        return token.balanceOf(address(vault)) - vault.locked();
    }

    // ================================================================ happy paths

    function test_happyPath_partialPickup_thenDelivery() public {
        uint256 id = _propose(20, UNIT); // 20 units at ₦5,000 = 20 money units, goods only
        vm.prank(rider); vault.riderPickup(id, true, 18);
        vm.prank(checker); vault.attestPickup(id, 19, false);
        vault.settlePickup(id);
        assertEq(token.balanceOf(payout), 18 * UNIT, "supplier paid for 18");
        vm.prank(rider); vault.riderArrive(id, true);
        vm.prank(checker); vault.attestDelivery(id, 18, false);
        vm.prank(owner); vault.ownerConfirm(id, true, false);
        vm.expectEmit(true, false, false, true); emit StockRunVault.DeliveryRecorded(id, 2, 0, 0);
        vault.settleDelivery(id);
        assertEq(token.balanceOf(rider), 0, "the vault never pays the logistics company");
        assertEq(vault.locked(), 0);
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Delivered));
        (uint8 v, uint8 short_) = _verdict(id);
        assertEq(v, 2, "delivered in full"); assertEq(short_, 0);
    }

    function test_ordersLockGoodsMoneyOnly() public {
        vm.prank(agent); uint256 id = vault.proposeOrder(SUP, 10, UNIT, 0, 0, rider);
        assertEq(vault.locked(), 10 * UNIT, "goods only, no delivery fee");
        assertEq(vault.spentThisWeek(), 10 * UNIT);
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Locked));
    }

    /// RestockGuard's total is the goods alone: an order exactly at the auto-approve limit (40 units) locks
    /// without asking, which it could not if a delivery fee were added on top.
    function test_restockGuardTotalExcludesDeliveryFee() public {
        uint256 id = _propose(40, UNIT);
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Locked));
        assertEq(vault.locked(), 40 * UNIT);
    }

    /// The delivery fee is paid outside StockRun, so settling a delivery must never move funds: no token
    /// transfer at all, and every balance and the vault's accounting are unchanged, for every verdict.
    function test_deliverySettlement_neverTransfersFunds() public {
        uint256 full = _atShop(10, 10, true);       // delivered in full
        uint256 short_ = _atShop(10, 7, false);     // 3 short
        uint256 held = _atShop(10, 10, false);      // owner silent: WAIT
        uint256[6] memory before = _balances();
        vm.expectCall(address(token), abi.encodeWithSelector(MockToken.transfer.selector), 0);
        vm.expectCall(address(token), abi.encodeWithSelector(MockToken.transferFrom.selector), 0);
        vault.settleDelivery(full);
        vault.settleDelivery(short_);
        vault.settleDelivery(held);
        vm.warp(block.timestamp + 24 hours);
        vault.settleDelivery(held);                 // owner timeout: recorded in full
        uint256[6] memory afterB = _balances();
        for (uint256 i; i < 6; i++) assertEq(afterB[i], before[i], "delivery settlement moved funds");
        (uint8 v1,) = _verdict(full); (uint8 v2, uint8 q2) = _verdict(short_); (uint8 v3,) = _verdict(held);
        assertEq(v1, 2); assertEq(v2, 1); assertEq(q2, 3); assertEq(v3, 2);
    }

    function test_fullPickup_whenCountsMatch() public {
        _pickedUp(10, 10, 10);
        assertEq(token.balanceOf(payout), 10 * UNIT);
    }

    function test_shortDelivery_recordsVerdictForTheBuyersClaim() public {
        uint256 id = _atShop(10, 7, false);
        uint256 freeBefore = _free();
        vm.expectEmit(true, false, false, true); emit StockRunVault.DeliveryRecorded(id, 1, 3, 4);
        vault.settleDelivery(id);
        (uint8 v, uint8 short_) = _verdict(id);
        assertEq(v, 1, "short"); assertEq(short_, 3, "3 missing");
        assertEq(_free(), freeBefore, "no money moves: the claim is against the logistics company");
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Delivered));
    }

    // ================================================================ handlers: self-pickup and logistics companies

    function test_selfPickup_ownerCountPaysSupplier_noDeliveryStep() public {
        vm.prank(agent); uint256 id = vault.proposeOrder(SUP, 10, UNIT, 0, 0, owner);
        vm.prank(owner); vault.riderPickup(id, true, 9);         // owner at the supplier: 9 good cartons
        vault.settlePickup(id);                                   // no photo needed: the owner's count stands
        assertEq(token.balanceOf(payout), 9 * UNIT, "supplier paid for what the owner took");
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Delivered), "nothing left to deliver");
        assertEq(vault.locked(), 0, "the 10th carton's money is free again");
    }

    function test_strangerCannotBeTheHandler() public {
        vm.prank(agent); vm.expectRevert(StockRunVault.UntrustedHandler.selector);
        vault.proposeOrder(SUP, 10, UNIT, 0, 0, stranger);
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
        vault.proposeOrder(SUP, 5, UNIT, 0, 0, other);
        vm.warp(block.timestamp + 1 days); vault.applyCarrier(other);
        vm.prank(agent); uint256 id = vault.proposeOrder(SUP, 5, UNIT, 0, 0, other);
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

    function test_ownerSilent_recordsDeliveredAfterTimeout() public {
        uint256 id = _atShop(10, 10, false);
        vm.expectEmit(true, false, false, true); emit StockRunVault.DeliveryHeld(id, 5);
        vault.settleDelivery(id); // owner has not answered yet: WAIT
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.PickedUp));
        vm.warp(block.timestamp + 24 hours);
        vault.settleDelivery(id);
        (uint8 v,) = _verdict(id);
        assertEq(v, 2, "recorded as delivered after 24h");
        assertEq(token.balanceOf(rider), 0);
    }

    // ================================================================ RestockGuard rules

    function test_agentCannotOverspend() public {
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(StockRunVault.Rejected.selector, uint8(2)));
        vault.proposeOrder(SUP, 200, UNIT, 0, 0, rider); // 200 units > budget 100
    }

    function test_unknownSupplierRejected() public {
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(StockRunVault.Rejected.selector, uint8(1)));
        vault.proposeOrder(keccak256("stranger"), 5, UNIT, 0, 0, rider);
    }

    function test_aboveLimitNeedsOwner() public {
        uint256 id = _propose(50, UNIT); // 50 units > limit 40, within budget
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.AwaitingOwner));
        vm.prank(owner); vault.approveOrder(id);
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Locked));
    }

    function test_ownerCategoryAndDistanceNeedOwner() public {
        vm.startPrank(agent);
        uint256 a = vault.proposeOrder(SUP, 5, UNIT, 6, 0, rider); // cat 6
        uint256 b = vault.proposeOrder(SUP, 5, UNIT, 0, 3, rider); // > 10 km
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
        vault.proposeOrder(SUP, 255, 2 * UNIT, 0, 0, rider);
    }

    function test_rule2_roundingNeverOverstatesBudget() public {
        vm.prank(owner); vault.setWeeklyBudget(10 * UNIT + UNIT / 2);   // 10.5 units left
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(StockRunVault.Rejected.selector, uint8(2)));
        vault.proposeOrder(SUP, 10, (UNIT * 108) / 100, 0, 0, rider); // 10.8 units, rounded up to 11: over budget
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
        vault.proposeOrder(SUP, 5, UNIT, 0, 0, rider);
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

    // ================================================================ deposit cap and the fixed payout wallet

    function test_depositCap_refusesAboveMaxBalance() public {
        StockRunVault capped = new StockRunVault(IERC20Min(address(token)), circuits, restockId, pickupId, deliveryId, UNIT, owner, agent, checker,
            100 * UNIT, 40 * UNIT, new address[](0), stockrunPayout, 10 * UNIT, address(0), 0);
        vm.startPrank(owner);
        token.approve(address(capped), type(uint256).max);
        capped.deposit(6 * UNIT);
        vm.expectRevert(StockRunVault.OverCap.selector); capped.deposit(5 * UNIT);   // 11 > 10
        capped.deposit(4 * UNIT);                                                    // exactly the cap
        vm.stopPrank();
        assertEq(token.balanceOf(address(capped)), 10 * UNIT);
        vm.prank(stranger); vm.expectRevert(StockRunVault.OverCap.selector); capped.deposit(1);
    }

    // ================================================================ StockRun's deposit fee (1.5%)

    function _feeVault(uint256 cap) internal returns (StockRunVault v) {
        v = new StockRunVault(IERC20Min(address(token)), circuits, restockId, pickupId, deliveryId, UNIT, owner, agent, checker,
            100 * UNIT, 40 * UNIT, new address[](0), stockrunPayout, cap, feeWallet, 150);
        vm.prank(owner); token.approve(address(v), type(uint256).max);
    }
    address feeWallet = makeAddr("stockrunFeeWallet");

    function test_depositFee_vaultGetsAll_feePaidOnTop() public {
        StockRunVault v = _feeVault(0);
        uint256 before = token.balanceOf(owner);
        vm.prank(owner); v.deposit(1_000e6);
        assertEq(token.balanceOf(address(v)), 1_000e6, "the vault holds the full deposit");
        assertEq(token.balanceOf(feeWallet), 15e6, "1.5% to StockRun");
        assertEq(before - token.balanceOf(owner), 1_015e6, "the depositor paid deposit + fee");
        assertEq(v.depositFee(333), 4, "rounded down");
    }

    function test_depositFee_capCountsTheDepositOnly() public {
        StockRunVault v = _feeVault(10 * UNIT);
        vm.startPrank(owner);
        v.deposit(10 * UNIT);                                                         // exactly the cap; the fee goes elsewhere
        vm.expectRevert(StockRunVault.OverCap.selector); v.deposit(1);
        vm.stopPrank();
        assertEq(token.balanceOf(address(v)), 10 * UNIT);
        assertEq(token.balanceOf(feeWallet), 10 * UNIT * 150 / 10_000);
    }

    function test_depositFee_withoutAllowanceForTheFee_reverts() public {
        StockRunVault v = _feeVault(0);
        vm.startPrank(owner);
        token.approve(address(v), 1_000e6);                                           // the deposit only, not the fee
        vm.expectRevert(); v.deposit(1_000e6);
        vm.stopPrank();
        assertEq(token.balanceOf(address(v)), 0, "nothing moved");
    }

    function test_depositFee_isBounded() public {
        vm.expectRevert(bytes("fee"));
        new StockRunVault(IERC20Min(address(token)), circuits, restockId, pickupId, deliveryId, UNIT, owner, agent, checker, 0, 0, new address[](0), stockrunPayout, 0, feeWallet, 501);
        vm.expectRevert(bytes("fee recipient"));
        new StockRunVault(IERC20Min(address(token)), circuits, restockId, pickupId, deliveryId, UNIT, owner, agent, checker, 0, 0, new address[](0), stockrunPayout, 0, address(0), 150);
    }

    function test_noFee_whenBpsIsZero() public {
        assertEq(vault.depositFeeBps(), 0);
        uint256 before = token.balanceOf(owner);
        vm.prank(owner); vault.deposit(10e6);
        assertEq(before - token.balanceOf(owner), 10e6);
    }

    function test_noCap_whenMaxBalanceIsZero() public {
        assertEq(vault.maxBalance(), 0);
        vm.prank(owner); vault.deposit(400 * UNIT);
        assertEq(token.balanceOf(address(vault)), 900 * UNIT);
    }

    function test_sellerPaidThroughDefaultPayout_isApprovedAtOnce() public {
        bytes32 shop = keccak256("new-seller");
        vm.prank(owner); vault.queueSupplier(shop, 1, stockrunPayout);
        assertEq(vault.supplierStatus(shop), 1, "approved immediately");
        assertEq(vault.supplierPayout(shop), stockrunPayout);
        vm.prank(agent); uint256 id = vault.proposeOrder(shop, 5, UNIT, 0, 0, rider);
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Locked), "can order in the same sitting");
    }

    function test_anyOtherPayout_stillWaits24h() public {
        bytes32 shop = keccak256("new-seller");
        vm.prank(owner); vault.queueSupplier(shop, 1, stranger);
        assertEq(vault.supplierStatus(shop), 0, "not yet");
        vm.prank(agent); vm.expectRevert(abi.encodeWithSelector(StockRunVault.Rejected.selector, uint8(1)));
        vault.proposeOrder(shop, 5, UNIT, 0, 0, rider);
        vm.warp(block.timestamp + 1 days); vault.applySupplier(shop);
        assertEq(vault.supplierPayout(shop), stranger);
    }

    function test_onlyOwnerCanUseTheInstantApproval() public {
        vm.prank(agent); vm.expectRevert(StockRunVault.NotAuthorized.selector);
        vault.queueSupplier(keccak256("x"), 1, stockrunPayout);
    }

    function test_stalePickup_refundsLockedFunds() public {
        uint256 id = _propose(10, UNIT);
        vm.warp(block.timestamp + 48 hours);
        vault.refundStale(id);
        assertEq(vault.locked(), 0);
        assertEq(uint8(_status(id)), uint8(StockRunVault.Status.Refunded));
    }
}
