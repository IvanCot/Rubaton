// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {ERC20Burnable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Burnable.sol";

contract DemoRuba is ERC20, ERC20Permit, ERC20Burnable {
    constructor(address holder) ERC20("RUBA Demo", "RUBA") ERC20Permit("RUBA Demo") {
        _mint(holder, 60_000 * 10 ** decimals());
    }
}

contract Redemption {
    error IssuerOnly();
    error AlreadyRedeemed();
    error InvalidAmount();

    DemoRuba public immutable token;
    address public immutable issuer;
    mapping(bytes32 => bool) public redeemed;

    event Redeemed(bytes32 indexed requestId, address indexed owner, uint256 amount);

    constructor(DemoRuba token_, address issuer_) {
        token = token_;
        issuer = issuer_;
    }

    function redeem(bytes32 requestId, address owner, uint256 amount) external {
        if (msg.sender != issuer) revert IssuerOnly();
        if (redeemed[requestId]) revert AlreadyRedeemed();
        if (amount == 0) revert InvalidAmount();

        redeemed[requestId] = true;
        token.burnFrom(owner, amount);
        emit Redeemed(requestId, owner, amount);
    }
}
