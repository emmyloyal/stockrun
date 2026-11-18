// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ITapeOutFactory, ITapeOutProcessor, ITapeOutTransistors} from "../../src/interfaces/ITapeOutCircuits.sol";

/// Full tapeout rehearsal on a fork of X Layer mainnet (chain 196). There is no TapeOut testnet.
///   forge test --match-path test/fork/Tapeout.fork.t.sol --fork-url $XLAYER_RPC -vv
/// It creates a processor, mints NAND, tapes out every netlist in circuits/build/, and checks
/// circuitInfo, netlist and eval() against the reference-model vectors in circuits/build/vectors/.
/// Without a fork it is skipped. Nothing here touches the real chain: all state is local to the fork.
interface IERC20Approve { function approve(address, uint256) external returns (bool); function balanceOf(address) external view returns (uint256); }

contract TapeoutForkTest is Test {
    ITapeOutFactory constant FACTORY = ITapeOutFactory(0x1f09DAeFA827f02CBb40967cc91b259763760761);
    uint256 constant NAND = 0;
    uint256 constant SUPPLY = 100_000;      // the TapeOut app lists X Layer CPUs only with supplyCap >= 10,000
    uint256 constant MINT_PRICE = 1_000;    // per NAND in BEM units (8 dp) = 0.00001 BEM; paid to the creator (us). Factory caps it.

    address creator = makeAddr("stockrun-creator");
    ITapeOutProcessor cpu;
    ITapeOutTransistors nand;

    string[6] NAMES = ["CMP8", "MIN8", "SUB8", "RestockGuard", "PickupCheck", "DeliveryCheck"];

    function _art(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../circuits/build/", name, ".json"));
    }

    function _vec(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../circuits/build/vectors/", name, ".json"));
    }

    function setUp() public {
        if (block.chainid != 196) { vm.skip(true); return; }
        vm.deal(creator, 10 ether);
        vm.startPrank(creator);

        // Since the factory upgrade (impl 0x336e9F0F...), createCPU is nonpayable and pulls deployFee in BEM (ERC-20, 8 dp).
        uint256 deployFee = FACTORY.deployFee();
        address bem = FACTORY.bem();
        deal(bem, creator, deployFee);
        IERC20Approve(bem).approve(address(FACTORY), deployFee);
        assertLe(MINT_PRICE, FACTORY.MAX_MINT_PRICE(), "mint price cap");
        (address t, address c) = FACTORY.createCPU("StockRun", "STKRN", "Restocking decisions for Lagos shops", SUPPLY, MINT_PRICE);
        cpu = ITapeOutProcessor(c);
        nand = ITapeOutTransistors(t);
        assertTrue(FACTORY.isCPU(c), "isCPU");
        assertEq(cpu.transistors(), t, "transistors link");

        uint256 total;
        for (uint256 i; i < NAMES.length; i++) total += vm.parseJsonUint(_art(NAMES[i]), ".gates");
        // The new transistor implementation is nonpayable too: mint pulls amount * mintPrice + protocolFee in BEM.
        uint256 mintCost = total * nand.mintPrice() + nand.protocolFee();
        deal(bem, creator, mintCost);
        IERC20Approve(bem).approve(address(nand), mintCost);
        nand.mint(NAND, total);
        assertEq(nand.balanceOf(creator, NAND), total, "minted");
        console2.log("deployFee (BEM units, 8 dp)", deployFee);
        assertEq(IERC20Approve(bem).balanceOf(creator), 0, "fees pulled in BEM");
        console2.log("NAND minted", total);
        console2.log("mint cost (BEM units)", mintCost);
        console2.log("TAPEOUT_FEE (wei)", cpu.TAPEOUT_FEE());
        vm.stopPrank();
    }

    function _tapeout(string memory name) internal returns (uint256 id) {
        string memory art = _art(name);
        bytes memory nl = vm.parseJsonBytes(art, ".netlist");
        uint32 nIn = uint32(vm.parseJsonUint(art, ".nIn"));
        uint32 nOut = uint32(vm.parseJsonUint(art, ".nOut"));
        uint256 gates = vm.parseJsonUint(art, ".gates");

        uint256 before = nand.balanceOf(creator, NAND);
        uint256 fee = cpu.TAPEOUT_FEE();
        vm.prank(creator);
        id = cpu.tapeout{value: fee}(nl, nIn, nOut);

        assertEq(before - nand.balanceOf(creator, NAND), gates, "burns one NAND per gate");
        assertEq(cpu.ownerOf(id), creator, "circuit NFT owner");
        (uint32 i, uint32 o, uint32 s, uint32 g) = cpu.circuitInfo(id);
        assertEq(i, nIn); assertEq(o, nOut); assertEq(s, 0); assertEq(g, gates);
        assertEq(cpu.netlist(id), nl, "stored netlist");
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
