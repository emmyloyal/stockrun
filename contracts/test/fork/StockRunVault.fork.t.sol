// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITapeOutCircuits} from "../../src/interfaces/ITapeOutCircuits.sol";
import {VaultScenarios} from "../VaultScenarios.sol";
import {TapeoutHelper} from "./TapeoutHelper.sol";

/// Every vault scenario and attack test against the REAL taped-out circuits on an X Layer fork.
///   forge test --match-path test/fork/StockRunVault.fork.t.sol --fork-url $XLAYER_RPC
/// Skipped without a fork.
contract StockRunVaultForkTest is VaultScenarios, TapeoutHelper {
    function setUp() public {
        if (block.chainid != 196) { vm.skip(true); return; }
        string[] memory names = new string[](3);
        names[0] = "RestockGuard"; names[1] = "PickupCheck"; names[2] = "DeliveryCheck";
        _createProcessor(names);
        restockId = _tapeout("RestockGuard");
        pickupId = _tapeout("PickupCheck");
        deliveryId = _tapeout("DeliveryCheck");
        circuits = ITapeOutCircuits(address(cpu));
        _setUpVault();
    }
}
