// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITapeOutCircuits, IERC20Min} from "./interfaces/ITapeOutCircuits.sol";

/// @title StockRunVault
/// @notice Holds one shop's restocking funds. Every payment is decided by a TapeOut circuit.
/// @dev Design rules (see CLAUDE.md): the agent never moves money; the vault builds every circuit
///      input itself; a failed circuit call holds the order; owner approval never overrides a reject.
///      Goods are collected by a trusted handler, never by a stranger: the owner (self-pickup) or a
///      logistics company the owner approved. There are no bonds. Skeleton for the hackathon — not audited.
///      Orders lock goods money only. The delivery fee is paid by the buyer directly to the logistics company,
///      outside StockRun: settleDelivery records DeliveryCheck's verdict and never moves funds.
contract StockRunVault {
    // ---------------------------------------------------------------- types
    enum Status { None, AwaitingOwner, Locked, PickedUp, Delivered, Refunded }

    struct Order {
        bytes32 supplierId;
        address payout;        // supplier's off-ramp address, copied from the owner's registry at proposal
        address rider;         // handler: the owner (self-pickup) or an owner-approved logistics company's key
        uint8 ordered;         // order units
        uint8 cat;
        uint8 dist;
        uint256 unitPrice;     // token units per order unit
        Status status;
        uint64 createdAt;
        // pickup evidence
        bool atSupplier; bool riderCounted; uint8 riderCount;
        bool aiCounted; uint8 aiCount; bool pickupDamage;
        uint8 picked;          // payQty recorded at pickup
        // delivery evidence
        bool atShop; uint64 arrivedAt;
        bool aiDelivered; uint8 delivered; bool deliveryDamage;
        bool ownerOk; bool ownerIssue;
        // DeliveryCheck's verdict (recorded only; no funds move): 0 none yet, 1 short, 2 delivered in full
        uint8 deliveryVerdict; uint8 shortQty;
    }

    // ---------------------------------------------------------------- config
    IERC20Min public immutable token;
    ITapeOutCircuits public immutable circuits;
    uint256 public immutable restockGuardId;
    uint256 public immutable pickupCheckId;
    uint256 public immutable deliveryCheckId;
    uint256 public immutable unit;            // token amount per circuit money unit (e.g. ₦5,000 worth)
    /// StockRun's payout wallet, fixed at creation. Sellers paid there are approved at once (it can't be redirected).
    address public immutable defaultPayout;
    /// Most this vault may hold through deposit() (token units). 0 = no cap. The vault is unaudited: keep it small.
    uint256 public immutable maxBalance;

    address public immutable owner;           // shop owner
    address public agent;                     // AI agent key: propose only
    address public checkService;              // AI photo-check attestations

    uint256 public constant DELAY = 24 hours;
    uint256 public constant PICKUP_TIMEOUT = 48 hours;
    uint256 public constant OWNER_TIMEOUT = 24 hours;

    // ---------------------------------------------------------------- state
    uint256 public weeklyBudget; uint256 public spentThisWeek; uint256 public weekStart;
    uint256 public limit; uint256 public pendingLimit; uint256 public limitEffectiveAt;
    mapping(bytes32 => uint8) public supplierStatus;            // 0 unknown, 1 approved, 2 preferred, 3 blocked
    mapping(bytes32 => uint8) public pendingSupplierStatus;
    mapping(bytes32 => uint256) public supplierEffectiveAt;
    mapping(bytes32 => address) public supplierPayout;          // owner-registered off-ramp address per supplier
    mapping(bytes32 => address) public pendingSupplierPayout;
    mapping(address => bool) public carrier;                    // owner-approved logistics companies (their keys)
    mapping(address => bool) public pendingCarrier;
    mapping(address => uint256) public carrierEffectiveAt;
    uint256 public locked;                                      // funds locked in open orders
    Order[] public orders;

    // ---------------------------------------------------------------- events
    event OrderProposed(uint256 indexed id, uint8 decision, uint8 reason);
    event OrderLocked(uint256 indexed id, uint256 amount);
    event SupplierPaid(uint256 indexed id, address payout, uint8 qty, uint256 amount, uint8 reason);
    event PickupHeld(uint256 indexed id, uint8 reason);
    /// DeliveryCheck's final verdict: 2 delivered in full, 1 short by `shortQty`. Recorded only: no funds move.
    event DeliveryRecorded(uint256 indexed id, uint8 verdict, uint8 shortQty, uint8 reason);
    event DeliveryHeld(uint256 indexed id, uint8 reason);
    event Refunded(uint256 indexed id, uint256 amount);
    event SelfCollected(uint256 indexed id, uint8 qty);

    error NotAuthorized(); error BadStatus(); error CircuitFailed(); error Rejected(uint8 reason); error OrderTooLarge(); error NoPayout();
    error UntrustedHandler(); error OverCap();

    modifier only(address who) { if (msg.sender != who) revert NotAuthorized(); _; }

    constructor(
        IERC20Min token_, ITapeOutCircuits circuits_, uint256 restockId, uint256 pickupId, uint256 deliveryId,
        uint256 unit_, address owner_, address agent_, address checkService_, uint256 weeklyBudget_, uint256 limit_,
        address[] memory carriers_, address defaultPayout_, uint256 maxBalance_
    ) {
        defaultPayout = defaultPayout_; maxBalance = maxBalance_;
        token = token_; circuits = circuits_;
        restockGuardId = restockId; pickupCheckId = pickupId; deliveryCheckId = deliveryId;
        unit = unit_; owner = owner_; agent = agent_; checkService = checkService_;
        weeklyBudget = weeklyBudget_; limit = limit_; weekStart = block.timestamp;
        // Logistics companies the owner chose when setting up the shop. Later additions wait DELAY.
        for (uint256 i; i < carriers_.length; i++) { if (carriers_[i] != owner_ && carriers_[i] != address(0)) carrier[carriers_[i]] = true; }
    }

    // ================================================================ owner settings
    /// @notice Anyone may top the vault up, but never above maxBalance (when set).
    function deposit(uint256 amount) external {
        if (maxBalance != 0 && token.balanceOf(address(this)) + amount > maxBalance) revert OverCap();
        require(token.transferFrom(msg.sender, address(this), amount));
    }

    /// @notice Owner withdraws free funds. Funds locked in open orders stay in the vault.
    function withdraw(uint256 amount) external only(owner) {
        require(amount + locked <= token.balanceOf(address(this)), "locked");
        require(token.transfer(owner, amount));
    }

    function setWeeklyBudget(uint256 b) external only(owner) { weeklyBudget = b; } // TODO: delay increases too
    function queueLimit(uint256 l) external only(owner) { pendingLimit = l; limitEffectiveAt = block.timestamp + DELAY; }
    function applyLimit() external { require(limitEffectiveAt != 0 && block.timestamp >= limitEffectiveAt); limit = pendingLimit; limitEffectiveAt = 0; }

    /// @notice Owner sets a supplier's status and payout address. Only the owner, never the agent, decides
    ///         where supplier money goes. Changes wait DELAY; blocking (3) is immediate, and so is approving a
    ///         supplier paid through defaultPayout (fixed at creation, so the money can't be redirected).
    function queueSupplier(bytes32 id, uint8 status_, address payout_) external only(owner) {
        require(status_ <= 3);
        if (status_ == 3) { supplierStatus[id] = 3; supplierEffectiveAt[id] = 0; return; }
        if ((status_ == 1 || status_ == 2) && payout_ == address(0)) revert NoPayout();
        if ((status_ == 1 || status_ == 2) && payout_ == defaultPayout) {
            supplierStatus[id] = status_; supplierPayout[id] = payout_; supplierEffectiveAt[id] = 0; return;
        }
        pendingSupplierStatus[id] = status_; pendingSupplierPayout[id] = payout_;
        supplierEffectiveAt[id] = block.timestamp + DELAY;
    }
    function applySupplier(bytes32 id) external {
        require(supplierEffectiveAt[id] != 0 && block.timestamp >= supplierEffectiveAt[id]);
        supplierStatus[id] = pendingSupplierStatus[id]; supplierPayout[id] = pendingSupplierPayout[id];
        supplierEffectiveAt[id] = 0;
    }

    function setAgent(address a) external only(owner) { agent = a; }

    // ================================================================ logistics companies
    /// @notice Owner approves (or removes) a logistics company's key. Approval waits DELAY, like a
    ///         supplier payout change; removal is immediate and holds that company's open pickups.
    function queueCarrier(address c, bool approve) external only(owner) {
        if (c == address(0) || c == owner) revert UntrustedHandler();
        if (!approve) { carrier[c] = false; carrierEffectiveAt[c] = 0; return; }
        pendingCarrier[c] = true; carrierEffectiveAt[c] = block.timestamp + DELAY;
    }
    function applyCarrier(address c) external {
        require(carrierEffectiveAt[c] != 0 && block.timestamp >= carrierEffectiveAt[c]);
        carrier[c] = pendingCarrier[c]; pendingCarrier[c] = false; carrierEffectiveAt[c] = 0;
    }
    /// @notice Who may collect goods: the owner (self-pickup) or an approved logistics company.
    function trustedHandler(address h) public view returns (bool) { return h == owner || carrier[h]; }

    // ================================================================ 1. order → RestockGuard
    /// @notice Locks goods money only. A delivery fee, if any, is paid by the buyer to the logistics company directly.
    function proposeOrder(
        bytes32 supplierId, uint8 ordered, uint256 unitPrice, uint8 cat, uint8 dist, address rider
    ) external only(agent) returns (uint256 id) {
        if (!trustedHandler(rider)) revert UntrustedHandler();
        id = orders.length;
        Order storage o = orders.push();
        o.supplierId = supplierId; o.payout = supplierPayout[supplierId]; o.ordered = ordered; o.unitPrice = unitPrice;
        o.cat = cat; o.dist = dist; o.rider = rider; o.createdAt = uint64(block.timestamp);
        _guard(id, false);
    }

    function approveOrder(uint256 id) external only(owner) {
        if (orders[id].status != Status.AwaitingOwner) revert BadStatus();
        _guard(id, true);
    }

    function _guard(uint256 id, bool ownerOk) internal {
        _rollWeek();
        Order storage o = orders[id];
        uint256 amount = _orderValue(o);      // goods only: the delivery fee is not StockRun's to hold
        uint256 remaining = weeklyBudget > spentThisWeek ? weeklyBudget - spentThisWeek : 0;

        // Rounding never favours spending: the order total rounds UP, budget and limit round DOWN.
        uint256 totalUnits = (amount + unit - 1) / unit;
        if (totalUnits > 255) revert OrderTooLarge();     // does not fit the 8-bit circuit: never approve by capping
        bytes memory input = _pack(
            _f(totalUnits, 8), _f(_unitsDown(remaining), 8), _f(_unitsDown(limit), 8),
            _f(supplierStatus[o.supplierId], 2), _f(o.cat, 3), _f(o.dist, 2), _f(ownerOk ? 1 : 0, 1), _f(0, 2)
        );
        uint256[] memory out = _unpack(_eval(restockGuardId, input), _w2(2, 3));
        uint8 decision = uint8(out[0]); uint8 reason = uint8(out[1]);
        emit OrderProposed(id, decision, reason);

        if (decision == 0) revert Rejected(reason);                       // REJECT: nothing stored
        if (decision == 1) { o.status = Status.AwaitingOwner; return; }    // ASK_OWNER
        if (decision == 2) {                                               // APPROVE
            o.status = Status.Locked; locked += amount; spentThisWeek += amount;
            emit OrderLocked(id, amount); return;
        }
        revert CircuitFailed();
    }

    // ================================================================ 2. pickup → PickupCheck
    /// @notice The handler confirms the goods at the supplier: the owner when collecting, or the logistics
    ///         company once its rider has checked them against the order. The handler's count is what the
    ///         supplier is paid for; a photo count from the check service, if one is given, can only lower it.
    function riderPickup(uint256 id, bool atSupplier, uint8 riderCount) external {
        Order storage o = orders[id];
        if (msg.sender != o.rider) revert NotAuthorized();
        if (o.status != Status.Locked) revert BadStatus();
        o.atSupplier = atSupplier; o.riderCount = riderCount; o.riderCounted = true;
    }

    function attestPickup(uint256 id, uint8 aiCount, bool damage) external only(checkService) {
        Order storage o = orders[id];
        if (o.status != Status.Locked) revert BadStatus();
        o.aiCount = aiCount; o.pickupDamage = damage; o.aiCounted = true;
    }

    function settlePickup(uint256 id) external {
        Order storage o = orders[id];
        if (o.status != Status.Locked || !o.riderCounted) revert BadStatus();
        // PickupCheck's `bonded` input (circuit #2, unchanged) now carries "the handler is trusted". It is
        // re-checked here, so removing a logistics company holds its pickups (reason 2).
        bool trusted = trustedHandler(o.rider);
        uint8 photoCount = o.aiCounted ? o.aiCount : o.riderCount;   // no photo: the handler's count stands
        bytes memory input = _pack(
            _f(o.atSupplier ? 1 : 0, 1), _f(o.ordered, 8), _f(photoCount, 8), _f(o.riderCount, 8),
            _f(o.pickupDamage ? 1 : 0, 1), _f(trusted ? 1 : 0, 1), _f(0, 0), _f(0, 0)
        );
        uint256[] memory out = _unpack(_eval(pickupCheckId, input), _w3(2, 8, 3));
        uint8 decision = uint8(out[0]); uint8 qty = uint8(out[1]); uint8 reason = uint8(out[2]);

        if (decision == 0) { emit PickupHeld(id, reason); return; }          // HOLD: rider can resubmit
        if (qty == 0 || qty > o.ordered) revert CircuitFailed();
        o.picked = qty; o.status = Status.PickedUp;
        uint256 pay = uint256(qty) * o.unitPrice;
        uint256 unused = _orderValue(o) - pay;
        locked -= pay + unused;              // supplier share leaves; value of unpicked goods is released
        if (unused > 0) spentThisWeek -= unused;
        require(token.transfer(o.payout, pay));
        emit SupplierPaid(id, o.payout, qty, pay, reason);
        // Self-pickup: the owner has the goods in hand, so there is no delivery step.
        if (o.rider == owner) { o.status = Status.Delivered; emit SelfCollected(id, qty); }
    }

    // ================================================================ 3. delivery → DeliveryCheck
    function riderArrive(uint256 id, bool atShop) external {
        Order storage o = orders[id];
        if (msg.sender != o.rider) revert NotAuthorized();
        if (o.status != Status.PickedUp) revert BadStatus();
        o.atShop = atShop; if (atShop && o.arrivedAt == 0) o.arrivedAt = uint64(block.timestamp);
    }

    function attestDelivery(uint256 id, uint8 delivered, bool damage) external only(checkService) {
        Order storage o = orders[id];
        if (o.status != Status.PickedUp) revert BadStatus();
        o.delivered = delivered; o.deliveryDamage = damage; o.aiDelivered = true;
    }

    function ownerConfirm(uint256 id, bool ok, bool issue) external only(owner) {
        Order storage o = orders[id];
        if (o.status != Status.PickedUp) revert BadStatus();
        o.ownerOk = ok; o.ownerIssue = issue;
    }

    function settleDelivery(uint256 id) external {
        Order storage o = orders[id];
        if (o.status != Status.PickedUp || !o.aiDelivered) revert BadStatus();
        bool timeout = o.arrivedAt != 0 && block.timestamp >= o.arrivedAt + OWNER_TIMEOUT;
        bytes memory input = _pack(
            _f(o.atShop ? 1 : 0, 1), _f(o.picked, 8), _f(o.delivered, 8), _f(o.deliveryDamage ? 1 : 0, 1),
            _f(o.ownerOk ? 1 : 0, 1), _f(o.ownerIssue ? 1 : 0, 1), _f(timeout ? 1 : 0, 1), _f(0, 0)
        );
        uint256[] memory out = _unpack(_eval(deliveryCheckId, input), _w3(2, 8, 3));
        uint8 decision = uint8(out[0]); uint8 shortQty = uint8(out[1]); uint8 reason = uint8(out[2]);

        if (decision == 0) { emit DeliveryHeld(id, reason); return; }        // WAIT / HOLD
        // Record the verdict only. The supplier was paid at pickup and the buyer pays the logistics company
        // directly, so nothing here touches the vault's funds. A short delivery (decision 1, circuit #3's
        // COMPENSATE) is the buyer's evidence for a claim against the logistics company, made off-chain.
        if (decision == 1) { if (shortQty == 0 || shortQty > o.picked) revert CircuitFailed(); }
        else if (decision == 2) { shortQty = 0; }
        else revert CircuitFailed();
        o.status = Status.Delivered; o.deliveryVerdict = decision; o.shortQty = shortQty;
        emit DeliveryRecorded(id, decision, shortQty, reason);
    }

    /// @notice Refund an order whose pickup never happened.
    function refundStale(uint256 id) external {
        Order storage o = orders[id];
        if (o.status != Status.Locked || block.timestamp < o.createdAt + PICKUP_TIMEOUT) revert BadStatus();
        uint256 amount = _orderValue(o);
        o.status = Status.Refunded; locked -= amount;
        spentThisWeek = spentThisWeek > amount ? spentThisWeek - amount : 0;
        emit Refunded(id, amount);
    }

    function ordersLength() external view returns (uint256) { return orders.length; }

    // ================================================================ internals
    function _orderValue(Order storage o) internal view returns (uint256) { return uint256(o.ordered) * o.unitPrice; }

    /// Budget-side amounts round down (never overstated). Capping at 255 is safe here because
    /// the order total is at most 255 units, so "total > capped value" stays exact.
    function _unitsDown(uint256 amount) internal view returns (uint256) {
        uint256 u = amount / unit;
        return u > 255 ? 255 : u;
    }

    function _rollWeek() internal {
        if (block.timestamp >= weekStart + 7 days) { weekStart = block.timestamp; spentThisWeek = 0; }
    }

    function _eval(uint256 circuitId, bytes memory input) internal view returns (bytes memory out) {
        try circuits.eval(circuitId, input) returns (bytes memory r) { out = r; } catch { revert CircuitFailed(); }
    }

    // ---- bit packing (TAP-02 §5): vector bit i = bit (i mod 8) of byte floor(i/8), LSB-first.
    // Fields in docs/CIRCUITS.md order; field wire k = bit k of the value. The vector is the
    // little-endian integer sum(v_j << offset_j). MUST match circuits/reference/pack.ts.
    struct F { uint256 v; uint256 w; }
    function _f(uint256 v, uint256 w) internal pure returns (F memory) { require(w == 0 || v < (1 << w), "field"); return F(v, w); }

    function _pack(F memory a, F memory b, F memory c, F memory d, F memory e, F memory f, F memory g, F memory h)
        internal pure returns (bytes memory)
    {
        F[8] memory fs = [a, b, c, d, e, f, g, h];
        uint256 acc; uint256 nbits;
        for (uint256 i; i < 8; i++) { acc |= fs[i].v << nbits; nbits += fs[i].w; }
        bytes memory out = new bytes((nbits + 7) / 8);
        for (uint256 i; i < out.length; i++) out[i] = bytes1(uint8(acc >> (8 * i)));
        return out;
    }

    function _unpack(bytes memory data, uint256[] memory widths) internal pure returns (uint256[] memory vals) {
        uint256 total;
        for (uint256 i; i < widths.length; i++) total += widths[i];
        if (data.length * 8 < total || data.length > 32) revert CircuitFailed();
        uint256 acc;
        for (uint256 i; i < data.length; i++) acc |= uint256(uint8(data[i])) << (8 * i);
        vals = new uint256[](widths.length);
        uint256 pos;
        for (uint256 i; i < widths.length; i++) { vals[i] = (acc >> pos) & ((1 << widths[i]) - 1); pos += widths[i]; }
    }

    function _w2(uint256 a, uint256 b) internal pure returns (uint256[] memory w) { w = new uint256[](2); w[0] = a; w[1] = b; }
    function _w3(uint256 a, uint256 b, uint256 c) internal pure returns (uint256[] memory w) { w = new uint256[](3); w[0] = a; w[1] = b; w[2] = c; }
}
