// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {console2} from "forge-std/Test.sol";
import {TapeoutHelper} from "./TapeoutHelper.sol";

/// Full tapeout rehearsal on a fork of X Layer mainnet (chain 196). There is no TapeOut testnet.
///   forge test --match-path test/fork/Tapeout.fork.t.sol --fork-url $XLAYER_RPC -vv
/// Creates a processor, mints NAND, tapes out every netlist in circuits/build/, and checks
/// circuitInfo, netlist and eval() against the reference-model vectors in circuits/build/vectors/.
/// Skipped without a fork. All state is local to the fork.
contract TapeoutForkTest is TapeoutHelper {
    function setUp() public {
        if (block.chainid != 196) { vm.skip(true); return; }
        string[] memory names = new string[](6);
        names[0] = "CMP8"; names[1] = "MIN8"; names[2] = "SUB8";
        names[3] = "RestockGuard"; names[4] = "PickupCheck"; names[5] = "DeliveryCheck";
        _createProcessor(names);
    }

    function _checkEval(string memory name, uint256 id) internal view {
        string memory v = _vec(name);
        bytes[] memory ins = vm.parseJsonBytesArray(v, ".ins");
        bytes[] memory outs = vm.parseJsonBytesArray(v, ".outs");
        uint256 gasMax;
        for (uint256 k; k < ins.length; k++) {
            uint256 g0 = gasleft();
            bytes memory got = cpu.eval(id, ins[k]);
            uint256 used = g0 - gasleft();
            if (used > gasMax) gasMax = used;
            assertEq(got, outs[k], string.concat(name, " vector ", vm.toString(k)));
        }
        console2.log(string.concat(name, ": vectors matched / max eval gas"), ins.length, gasMax);
    }

    function _run(string memory name) internal { _checkEval(name, _tapeout(name)); }

    function test_fork_CMP8() public { _run("CMP8"); }
    function test_fork_MIN8() public { _run("MIN8"); }
    function test_fork_SUB8() public { _run("SUB8"); }
    function test_fork_RestockGuard() public { _run("RestockGuard"); }
    function test_fork_PickupCheck() public { _run("PickupCheck"); }
    function test_fork_DeliveryCheck() public { _run("DeliveryCheck"); }

    function test_fork_tapeoutRejectsWrongFee() public {
        bytes memory nl = vm.parseJsonBytes(_art("CMP8"), ".netlist");
        uint256 fee = cpu.TAPEOUT_FEE();
        vm.prank(creator);
        vm.expectRevert(bytes("tapeout fee"));
        cpu.tapeout{value: fee + 1}(nl, 16, 1);
    }
}
