pragma solidity >=0.4.24;
pragma experimental ABIEncoderV2;

interface IBaseTribeoneBridge {
    function suspendInitiation() external;

    function resumeInitiation() external;
}
