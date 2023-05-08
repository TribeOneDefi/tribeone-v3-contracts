pragma solidity >=0.4.24;
pragma experimental ABIEncoderV2;

interface IDebtMigrator {
    function finalizeDebtMigration(
        address account,
        uint debtSharesMigrated,
        uint escrowMigrated,
        uint liquidHakaMigrated,
        bytes calldata debtPayload
    ) external;
}
