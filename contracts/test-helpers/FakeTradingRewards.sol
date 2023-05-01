pragma solidity ^0.5.16;

import "../TradingRewards.sol";

import "../interfaces/IExchanger.sol";

contract FakeTradingRewards is TradingRewards {
    IERC20 public _mockTribeOneToken;

    constructor(
        address owner,
        address periodController,
        address resolver,
        address mockTribeOneToken
    ) public TradingRewards(owner, periodController, resolver) {
        _mockTribeOneToken = IERC20(mockTribeOneToken);
    }

    // TribeOne is mocked with an ERC20 token passed via the constructor.
    function tribeone() internal view returns (IERC20) {
        return IERC20(_mockTribeOneToken);
    }

    // Return msg.sender so that onlyExchanger modifier can be bypassed.
    function exchanger() internal view returns (IExchanger) {
        return IExchanger(msg.sender);
    }
}
