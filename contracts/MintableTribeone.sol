pragma solidity ^0.5.16;
pragma experimental ABIEncoderV2;

// Inheritance
import "./BaseTribeone.sol";

// https://docs.tribeone.io/contracts/source/contracts/mintabletribeone
contract MintableTribeone is BaseTribeone {
    bytes32 private constant CONTRACT_TRIBEONE_BRIDGE = "TribeoneBridgeToBase";

    constructor(
        address payable _proxy,
        TokenState _tokenState,
        address _owner,
        uint _totalSupply,
        address _resolver
    ) public BaseTribeone(_proxy, _tokenState, _owner, _totalSupply, _resolver) {}

    /* ========== INTERNALS =================== */
    function _mintSecondary(address account, uint amount) internal {
        tokenState.setBalanceOf(account, tokenState.balanceOf(account).add(amount));
        emitTransfer(address(this), account, amount);
        totalSupply = totalSupply.add(amount);
    }

    function onlyAllowFromBridge() internal view {
        require(msg.sender == tribeoneBridge(), "Can only be invoked by bridge");
    }

    /* ========== MODIFIERS =================== */

    modifier onlyBridge() {
        onlyAllowFromBridge();
        _;
    }

    /* ========== VIEWS ======================= */
    function resolverAddressesRequired() public view returns (bytes32[] memory addresses) {
        bytes32[] memory existingAddresses = BaseTribeone.resolverAddressesRequired();
        bytes32[] memory newAddresses = new bytes32[](1);
        newAddresses[0] = CONTRACT_TRIBEONE_BRIDGE;
        addresses = combineArrays(existingAddresses, newAddresses);
    }

    function tribeoneBridge() internal view returns (address) {
        return requireAndGetAddress(CONTRACT_TRIBEONE_BRIDGE);
    }

    /* ========== RESTRICTED FUNCTIONS ========== */

    function mintSecondary(address account, uint amount) external onlyBridge {
        _mintSecondary(account, amount);
    }

    function mintSecondaryRewards(uint amount) external onlyBridge {
        IRewardsDistribution _rewardsDistribution = rewardsDistribution();
        _mintSecondary(address(_rewardsDistribution), amount);
        _rewardsDistribution.distributeRewards(amount);
    }

    function burnSecondary(address account, uint amount) external onlyBridge systemActive {
        tokenState.setBalanceOf(account, tokenState.balanceOf(account).sub(amount));
        emitTransfer(account, address(0), amount);
        totalSupply = totalSupply.sub(amount);
    }
}
