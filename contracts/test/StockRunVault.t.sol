// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ITapeOutCircuits} from "../src/interfaces/ITapeOutCircuits.sol";
import {MockCircuits} from "./mocks/MockCircuits.sol";
import {VaultScenarios} from "./VaultScenarios.sol";

/// All vault scenarios against MockCircuits (offline). The same scenarios run against the real
/// taped-out circuits in fork/StockRunVault.fork.t.sol.
contract StockRunVaultTest is VaultScenarios {
    function setUp() public {
        MockCircuits m = new MockCircuits();
        circuits = ITapeOutCircuits(address(m));
        (restockId, pickupId, deliveryId) = (m.RESTOCK(), m.PICKUP(), m.DELIVERY());
        _setUpVault();
    }
}
