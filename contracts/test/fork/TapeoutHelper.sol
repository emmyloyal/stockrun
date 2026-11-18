// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test, console2} from "forge-std/Test.sol";
import {ITapeOutFactory, ITapeOutProcessor, ITapeOutTransistors} from "../../src/interfaces/ITapeOutCircuits.sol";

interface IERC20Approve {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// Creates a StockRun processor and tapes out netlists from circuits/build/ on an X Layer fork.
/// Fees are read live: createCPU and mint pull BEM, tapeout takes exactly TAPEOUT_FEE in OKB.
abstract contract TapeoutHelper is Test {
    ITapeOutFactory constant FACTORY = ITapeOutFactory(0x1f09DAeFA827f02CBb40967cc91b259763760761);
    uint256 constant NAND = 0;
    uint256 constant SUPPLY = 100_000;   // the TapeOut app lists X Layer CPUs only with supplyCap >= 10,000
    uint256 constant MINT_PRICE = 1_000; // per NAND in BEM units (8 dp) = 0.00001 BEM; paid to the creator (us)

    address creator = makeAddr("stockrun-creator");
    ITapeOutProcessor cpu;
    ITapeOutTransistors nand;

    function _art(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../circuits/build/", name, ".json"));
    }

    function _vec(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../circuits/build/vectors/", name, ".json"));
    }

    /// Creates the processor and mints exactly enough NAND for `names`.
    function _createProcessor(string[] memory names) internal {
        vm.deal(creator, 10 ether);
        vm.startPrank(creator);
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
        for (uint256 i; i < names.length; i++) total += vm.parseJsonUint(_art(names[i]), ".gates");
        uint256 mintCost = total * nand.mintPrice() + nand.protocolFee();
        deal(bem, creator, mintCost);
        IERC20Approve(bem).approve(address(nand), mintCost);
        nand.mint(NAND, total);
        assertEq(nand.balanceOf(creator, NAND), total, "minted");
        assertEq(IERC20Approve(bem).balanceOf(creator), 0, "fees pulled in BEM");
        vm.stopPrank();
        console2.log("deployFee (BEM units, 8 dp)", deployFee);
        console2.log("NAND minted / mint cost (BEM units)", total, mintCost);
        console2.log("TAPEOUT_FEE (wei)", cpu.TAPEOUT_FEE());
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
}
