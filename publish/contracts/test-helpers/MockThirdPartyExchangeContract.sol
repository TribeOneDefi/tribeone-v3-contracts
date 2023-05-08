pragma solidity ^0.5.16;

import "../interfaces/IAddressResolver.sol";
import "../interfaces/ITribeone.sol";

contract MockThirdPartyExchangeContract {
    IAddressResolver public resolver;

    constructor(IAddressResolver _resolver) public {
        resolver = _resolver;
    }

    function exchange(
        bytes32 src,
        uint amount,
        bytes32 dest
    ) external {
        ITribeone tribeone = ITribeone(resolver.getAddress("Tribeone"));

        tribeone.exchangeWithTrackingForInitiator(src, amount, dest, address(this), "TRACKING_CODE");
    }
}
