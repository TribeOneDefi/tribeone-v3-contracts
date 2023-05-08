pragma solidity ^0.5.16;

// Inheritance
import "./interfaces/ISynth.sol";
import "./interfaces/ITribeone.sol";
import "./interfaces/IExchangeRates.sol";
import "./interfaces/IAddressResolver.sol";
import "./interfaces/IERC20.sol";

// https://docs.tribeone.io/contracts/source/contracts/synthutil
contract SynthUtil {
    IAddressResolver public addressResolverProxy;

    bytes32 internal constant CONTRACT_TRIBEONE = "Tribeone";
    bytes32 internal constant CONTRACT_EXRATES = "ExchangeRates";
    bytes32 internal constant HUSD = "hUSD";

    constructor(address resolver) public {
        addressResolverProxy = IAddressResolver(resolver);
    }

    function _tribeone() internal view returns (ITribeone) {
        return ITribeone(addressResolverProxy.requireAndGetAddress(CONTRACT_TRIBEONE, "Missing Tribeone address"));
    }

    function _exchangeRates() internal view returns (IExchangeRates) {
        return IExchangeRates(addressResolverProxy.requireAndGetAddress(CONTRACT_EXRATES, "Missing ExchangeRates address"));
    }

    function totalSynthsInKey(address account, bytes32 currencyKey) external view returns (uint total) {
        ITribeone tribeone = _tribeone();
        IExchangeRates exchangeRates = _exchangeRates();
        uint numSynths = tribeone.availableSynthCount();
        for (uint i = 0; i < numSynths; i++) {
            ISynth synth = tribeone.availableSynths(i);
            total += exchangeRates.effectiveValue(
                synth.currencyKey(),
                IERC20(address(synth)).balanceOf(account),
                currencyKey
            );
        }
        return total;
    }

    function synthsBalances(address account)
        external
        view
        returns (
            bytes32[] memory,
            uint[] memory,
            uint[] memory
        )
    {
        ITribeone tribeone = _tribeone();
        IExchangeRates exchangeRates = _exchangeRates();
        uint numSynths = tribeone.availableSynthCount();
        bytes32[] memory currencyKeys = new bytes32[](numSynths);
        uint[] memory balances = new uint[](numSynths);
        uint[] memory sUSDBalances = new uint[](numSynths);
        for (uint i = 0; i < numSynths; i++) {
            ISynth synth = tribeone.availableSynths(i);
            currencyKeys[i] = synth.currencyKey();
            balances[i] = IERC20(address(synth)).balanceOf(account);
            sUSDBalances[i] = exchangeRates.effectiveValue(currencyKeys[i], balances[i], HUSD);
        }
        return (currencyKeys, balances, sUSDBalances);
    }

    function synthsRates() external view returns (bytes32[] memory, uint[] memory) {
        bytes32[] memory currencyKeys = _tribeone().availableCurrencyKeys();
        return (currencyKeys, _exchangeRates().ratesForCurrencies(currencyKeys));
    }

    function synthsTotalSupplies()
        external
        view
        returns (
            bytes32[] memory,
            uint256[] memory,
            uint256[] memory
        )
    {
        ITribeone tribeone = _tribeone();
        IExchangeRates exchangeRates = _exchangeRates();

        uint256 numSynths = tribeone.availableSynthCount();
        bytes32[] memory currencyKeys = new bytes32[](numSynths);
        uint256[] memory balances = new uint256[](numSynths);
        uint256[] memory sUSDBalances = new uint256[](numSynths);
        for (uint256 i = 0; i < numSynths; i++) {
            ISynth synth = tribeone.availableSynths(i);
            currencyKeys[i] = synth.currencyKey();
            balances[i] = IERC20(address(synth)).totalSupply();
            sUSDBalances[i] = exchangeRates.effectiveValue(currencyKeys[i], balances[i], HUSD);
        }
        return (currencyKeys, balances, sUSDBalances);
    }
}
