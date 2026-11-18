// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITapeOutCircuits} from "../../src/interfaces/ITapeOutCircuits.sol";

/// @notice Implements the reference rules (docs/CIRCUITS.md) in Solidity so vault tests run without TapeOut.
/// Bit layout follows TAP-02 §5 (LSB-first), like StockRunVault._pack. Replace with fork tests against real circuits once taped out.
contract MockCircuits is ITapeOutCircuits {
    uint256 public constant RESTOCK = 1;
    uint256 public constant PICKUP = 2;
    uint256 public constant DELIVERY = 3;

    function eval(uint256 id, bytes calldata input) external pure returns (bytes memory) {
        if (id == RESTOCK) return _restock(input);
        if (id == PICKUP) return _pickup(input);
        if (id == DELIVERY) return _delivery(input);
        revert("unknown circuit");
    }

    function _bits(bytes calldata d, uint256 pos, uint256 w) internal pure returns (uint256 v) {
        for (uint256 k; k < w; k++) {
            uint256 i = pos + k;
            if ((i >> 3) < d.length) v |= ((uint256(uint8(d[i >> 3])) >> (i & 7)) & 1) << k; // missing bits read 0 (TAP-02)
        }
    }

    function _out(uint256 acc, uint256 nbits) internal pure returns (bytes memory out) {
        out = new bytes((nbits + 7) / 8);
        for (uint256 i; i < out.length; i++) out[i] = bytes1(uint8(acc >> (8 * i)));
    }

    function _restock(bytes calldata d) internal pure returns (bytes memory) {
        uint256 total = _bits(d, 0, 8); uint256 budget = _bits(d, 8, 8); uint256 lim = _bits(d, 16, 8);
        uint256 sup = _bits(d, 24, 2); uint256 cat = _bits(d, 26, 3); uint256 dist = _bits(d, 29, 2); bool ok = _bits(d, 31, 1) == 1;
        uint256 dec; uint256 reason;
        if (sup == 0 || sup == 3) { dec = 0; reason = 1; }
        else if (total > budget) { dec = 0; reason = 2; }
        else if (!ok && total > lim) { dec = 1; reason = 3; }
        else if (!ok && cat >= 6) { dec = 1; reason = 4; }
        else if (!ok && dist == 3) { dec = 1; reason = 5; }
        else { dec = 2; reason = 0; }
        return _out(dec | (reason << 2), 5);
    }

    function _pickup(bytes calldata d) internal pure returns (bytes memory) {
        bool at = _bits(d, 0, 1) == 1; uint256 ordered = _bits(d, 1, 8); uint256 ai = _bits(d, 9, 8);
        uint256 rider = _bits(d, 17, 8); bool damage = _bits(d, 25, 1) == 1; bool bonded = _bits(d, 26, 1) == 1;
        uint256 dec; uint256 qty; uint256 reason;
        if (!at) reason = 1; else if (!bonded) reason = 2; else if (damage) reason = 3;
        else {
            qty = ai < rider ? ai : rider; if (ordered < qty) qty = ordered;
            if (qty == 0) reason = 4; else if (qty < ordered) { dec = 1; reason = 5; } else { dec = 2; }
        }
        return _out(dec | (qty << 2) | (reason << 10), 13);
    }

    function _delivery(bytes calldata d) internal pure returns (bytes memory) {
        bool at = _bits(d, 0, 1) == 1; uint256 picked = _bits(d, 1, 8); uint256 delivered = _bits(d, 9, 8);
        bool damage = _bits(d, 17, 1) == 1; bool ok = _bits(d, 18, 1) == 1; bool issue = _bits(d, 19, 1) == 1; bool timeout = _bits(d, 20, 1) == 1;
        uint256 dec; uint256 shortQty; uint256 reason;
        if (!at) reason = 1; else if (damage) reason = 3;
        else if (delivered < picked) { dec = 1; shortQty = picked - delivered; reason = 4; }
        else if (issue) reason = 2; else if (ok || timeout) { dec = 2; } else reason = 5;
        return _out(dec | (shortQty << 2) | (reason << 10), 13);
    }
}
