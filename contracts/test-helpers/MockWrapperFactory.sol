pragma solidity ^0.5.16;

import "../SafeDecimalMath.sol";

contract MockWrapperFactory {
    using SafeMath for uint;
    using SafeDecimalMath for uint;

    uint public totalIssuedTribes;

    constructor() public {}

    function setTotalIssuedTribes(uint value) external {
        totalIssuedTribes = value;
    }
}
