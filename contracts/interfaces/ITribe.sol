pragma solidity >=0.4.24;

// https://docs.tribeone.io/contracts/source/interfaces/itribe
interface ITribe {
    // Views
    function currencyKey() external view returns (bytes32);

    function transferableTribes(address account) external view returns (uint);

    // Mutative functions
    function transferAndSettle(address to, uint value) external returns (bool);

    function transferFromAndSettle(
        address from,
        address to,
        uint value
    ) external returns (bool);

    // Restricted: used internally to Tribeone
    function burn(address account, uint amount) external;

    function issue(address account, uint amount) external;
}
