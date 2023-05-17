pragma solidity >=0.4.24;

import "./IERC20.sol";

interface ITribeRedeemer {
    // Rate of redemption - 0 for none
    function redemptions(address tribeProxy) external view returns (uint redeemRate);

    // hUSD balance of deprecated token holder
    function balanceOf(IERC20 tribeProxy, address account) external view returns (uint balanceOfInhUSD);

    // Full hUSD supply of token
    function totalSupply(IERC20 tribeProxy) external view returns (uint totalSupplyInhUSD);

    function redeem(IERC20 tribeProxy) external;

    function redeemAll(IERC20[] calldata tribeProxies) external;

    function redeemPartial(IERC20 tribeProxy, uint amountOfTribe) external;

    // Restricted to Issuer
    function deprecate(IERC20 tribeProxy, uint rateToRedeem) external;
}
