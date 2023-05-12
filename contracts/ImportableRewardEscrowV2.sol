pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// Inheritance
import "./BaseRewardEscrowV2.sol";

// https://docs.tribeone.io/contracts/RewardEscrow
contract ImportableRewardEscrowV2 is BaseRewardEscrowV2 {
    /* ========== ADDRESS RESOLVER CONFIGURATION ========== */
    bytes32 private constant CONTRACT_TRIBEONE_BRIDGE_BASE = "TribeoneBridgeToBase";

    /* ========== CONSTRUCTOR ========== */

    constructor(address _owner, address _resolver) public BaseRewardEscrowV2(_owner, _resolver) {}

    /* ========== VIEWS ======================= */

    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = BaseRewardEscrowV2.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](1);
        newAddresses[0] = CONTRACT_TRIBEONE_BRIDGE_BASE;
        return combineArrays(existingAddresses, newAddresses);
    }

    function tribeoneBridgeToBase() internal view returns (address) {
        return requireAndGetAddress(CONTRACT_TRIBEONE_BRIDGE_BASE);
    }

    /* ========== MUTATIVE FUNCTIONS ========== */

    function importVestingEntries(
        address account,
        uint256 escrowedAmount,
        VestingEntries.VestingEntry[] calldata vestingEntries
    ) external onlyTribeoneBridge {
        // add escrowedAmount to account and total aggregates
        state().updateEscrowAccountBalance(account, SafeCast.toInt256(escrowedAmount));

        // There must be enough balance in the contract to provide for the escrowed balance.
        require(
            totalEscrowedBalance() <= tribeoneERC20().balanceOf(address(this)),
            "Insufficient balance in the contract to provide for escrowed balance"
        );

        for (uint i = 0; i < vestingEntries.length; i++) {
            state().addVestingEntry(account, vestingEntries[i]);
        }
    }

    modifier onlyTribeoneBridge() {
        require(msg.sender == tribeoneBridgeToBase(), "Can only be invoked by TribeoneBridgeToBase contract");
        _;
    }
}
