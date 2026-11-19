// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console2} from "forge-std/Script.sol";
import {ITapeOutFactory, ITapeOutProcessor, ITapeOutTransistors} from "../src/interfaces/ITapeOutCircuits.sol";

interface IBEM {
    function approve(address, uint256) external returns (bool);
    function balanceOf(address) external view returns (uint256);
}

/// Mainnet tapeout of StockRun's three circuits on X Layer (chain 196), from the deployer wallet.
///
/// Rehearsal (simulation only, nothing is sent):
///   forge script script/Tapeout.s.sol --fork-url https://rpc.xlayer.tech
/// Real run (only after the owner says go):
///   forge script script/Tapeout.s.sol --rpc-url https://rpc.xlayer.tech --broadcast --slow
///
/// The key comes from the DEPLOYER_PRIVATE_KEY environment variable. Every fee is read live and checked
/// against hard ceilings below, so a fee change by the factory owner stops the script instead of overspending.
contract Tapeout is Script {
    ITapeOutFactory constant FACTORY = ITapeOutFactory(0x1f09DAeFA827f02CBb40967cc91b259763760761);
    address constant BEM_XLAYER = 0x60e62Efa9405d6873C5deaBD4E6CC91c25363952;
    uint256 constant NAND = 0;
    uint256 constant SUPPLY = 100_000;    // TapeOut app lists X Layer CPUs only with supplyCap >= 10,000
    uint256 constant MINT_PRICE = 1_000;  // 0.00001 BEM per NAND, paid to the creator (us)
    uint256 constant MINT_AMOUNT = 1_000; // 470 needed for the three circuits; the rest covers a re-spin

    // Ceilings: stop if TapeOut has raised its fees since we measured them (2026-11-19).
    uint256 constant MAX_DEPLOY_FEE = 10_000_000;        // 0.1 BEM
    uint256 constant MAX_PROTOCOL_FEE = 1_000_000;       // 0.01 BEM
    uint256 constant MAX_TAPEOUT_FEE = 0.0013 ether;     // 0.0013 OKB

    string[3] NAMES = ["RestockGuard", "PickupCheck", "DeliveryCheck"];

    function _art(string memory name) internal view returns (string memory) {
        return vm.readFile(string.concat(vm.projectRoot(), "/../circuits/build/", name, ".json"));
    }

    function run() external {
        require(block.chainid == 196, "not X Layer mainnet (or a fork of it)");
        uint256 pk = vm.envUint("DEPLOYER_PRIVATE_KEY");
        address me = vm.addr(pk);
        require(FACTORY.bem() == BEM_XLAYER, "factory BEM changed");

        uint256 deployFee = FACTORY.deployFee();
        uint256 protocolFee = FACTORY.protocolFee();
        require(deployFee <= MAX_DEPLOY_FEE, "deploy fee above ceiling");
        require(protocolFee <= MAX_PROTOCOL_FEE, "protocol fee above ceiling");
        uint256 mintCost = MINT_AMOUNT * MINT_PRICE + protocolFee;
        uint256 bemNeeded = deployFee + mintCost;

        uint256 gates;
        for (uint256 i; i < 3; i++) gates += vm.parseJsonUint(_art(NAMES[i]), ".gates");
        require(gates <= MINT_AMOUNT, "not enough NAND for the circuits");

        uint256 bem0 = IBEM(BEM_XLAYER).balanceOf(me);
        uint256 okb0 = me.balance;
        console2.log("deployer", me);
        console2.log("BEM balance / needed (8 dp)", bem0, bemNeeded);
        console2.log("OKB balance (wei)", okb0);
        require(bem0 >= bemNeeded, "not enough BEM");

        vm.startBroadcast(pk);
        // 1. Create the processor (pays deployFee in BEM).
        IBEM(BEM_XLAYER).approve(address(FACTORY), deployFee);
        (address t, address c) = FACTORY.createCPU("StockRun", "STKRN", "Restocking decisions for Lagos shops", SUPPLY, MINT_PRICE);
        ITapeOutProcessor cpu = ITapeOutProcessor(c);
        ITapeOutTransistors nand = ITapeOutTransistors(t);
        require(nand.mintPrice() == MINT_PRICE, "mint price not as set");

        // 2. Mint NAND (pays MINT_AMOUNT x mintPrice to us plus the protocol fee).
        uint256 pf = nand.protocolFee();
        require(pf <= MAX_PROTOCOL_FEE, "transistor protocol fee above ceiling");
        IBEM(BEM_XLAYER).approve(t, MINT_AMOUNT * MINT_PRICE + pf);
        nand.mint(NAND, MINT_AMOUNT);

        // 3. Tape out the three circuits (exactly TAPEOUT_FEE in OKB each).
        uint256 fee = cpu.TAPEOUT_FEE();
        require(fee <= MAX_TAPEOUT_FEE, "tapeout fee above ceiling");
        uint256[3] memory ids;
        for (uint256 i; i < 3; i++) {
            string memory art = _art(NAMES[i]);
            ids[i] = cpu.tapeout{value: fee}(vm.parseJsonBytes(art, ".netlist"), uint32(vm.parseJsonUint(art, ".nIn")), uint32(vm.parseJsonUint(art, ".nOut")));
        }
        vm.stopBroadcast();

        // 4. Check what is on chain against the build artifacts and the reference vectors.
        for (uint256 i; i < 3; i++) {
            string memory art = _art(NAMES[i]);
            (uint32 nIn, uint32 nOut,, uint32 g) = cpu.circuitInfo(ids[i]);
            require(nIn == vm.parseJsonUint(art, ".nIn") && nOut == vm.parseJsonUint(art, ".nOut") && g == vm.parseJsonUint(art, ".gates"), "circuitInfo mismatch");
            require(keccak256(cpu.netlist(ids[i])) == keccak256(vm.parseJsonBytes(art, ".netlist")), "netlist mismatch");
            require(cpu.ownerOf(ids[i]) == me, "circuit NFT not ours");
            string memory v = vm.readFile(string.concat(vm.projectRoot(), "/../circuits/build/vectors/", NAMES[i], ".json"));
            bytes[] memory ins = vm.parseJsonBytesArray(v, ".ins");
            bytes[] memory outs = vm.parseJsonBytesArray(v, ".outs");
            uint256 n = ins.length < 200 ? ins.length : 200;
            for (uint256 k; k < n; k++) require(keccak256(cpu.eval(ids[i], ins[k])) == keccak256(outs[k]), string.concat(NAMES[i], " eval mismatch"));
            console2.log(string.concat(NAMES[i], " id / vectors matched"), ids[i], n);
        }

        console2.log("processor (circuits)", c);
        console2.log("transistors (NAND)", t);
        console2.log("NAND left", nand.balanceOf(me, NAND));
        console2.log("BEM spent (8 dp)", bem0 - IBEM(BEM_XLAYER).balanceOf(me));
        console2.log("OKB fees sent (wei)", okb0 - me.balance);
    }
}
