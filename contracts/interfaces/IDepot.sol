pragma solidity >=0.4.24;

// https://docs.tribeone.io/contracts/source/interfaces/idepot
interface IDepot {
    // Views
    function fundsWallet() external view returns (address payable);

    function maxEthPurchase() external view returns (uint);

    function minimumDepositAmount() external view returns (uint);

    function synthsReceivedForEther(uint amount) external view returns (uint);

    function totalSellableDeposits() external view returns (uint);

    // Mutative functions
    function depositSynths(uint amount) external;

    function exchangeEtherForSynths() external payable returns (uint);

    function exchangeEtherForSynthsAtRate(uint guaranteedRate) external payable returns (uint);

    function withdrawMyDepositedSynths() external;

    // Note: On mainnet no HAKA has been deposited. The following functions are kept alive for testnet HAKA faucets.
    function exchangeEtherForHAKA() external payable returns (uint);

    function exchangeEtherForHAKAAtRate(uint guaranteedRate, uint guaranteedTribeoneRate) external payable returns (uint);

    function exchangeSynthsForHAKA(uint synthAmount) external returns (uint);

    function tribeoneReceivedForEther(uint amount) external view returns (uint);

    function tribeoneReceivedForSynths(uint amount) external view returns (uint);

    function withdrawTribeone(uint amount) external;
}
