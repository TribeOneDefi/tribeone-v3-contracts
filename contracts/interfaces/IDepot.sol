pragma solidity >=0.4.24;

// https://docs.tribeone.io/contracts/source/interfaces/idepot
interface IDepot {
    // Views
    function fundsWallet() external view returns (address payable);

    function maxEthPurchase() external view returns (uint);

    function minimumDepositAmount() external view returns (uint);

    function tribesReceivedForEther(uint amount) external view returns (uint);

    function totalSellableDeposits() external view returns (uint);

    // Mutative functions
    function depositTribes(uint amount) external;

    function exchangeEtherForTribes() external payable returns (uint);

    function exchangeEtherForTribesAtRate(uint guaranteedRate) external payable returns (uint);

    function withdrawMyDepositedTribes() external;

    // Note: On mainnet no HAKA has been deposited. The following functions are kept alive for testnet HAKA faucets.
    function exchangeEtherForHAKA() external payable returns (uint);

    function exchangeEtherForHAKAAtRate(uint guaranteedRate, uint guaranteedTribeoneRate) external payable returns (uint);

    function exchangeTribesForHAKA(uint tribeAmount) external returns (uint);

    function tribeetixReceivedForEther(uint amount) external view returns (uint);

    function tribeetixReceivedForTribes(uint amount) external view returns (uint);

    function withdrawTribeone(uint amount) external;
}
