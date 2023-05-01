'use strict';

const { contract } = require('hardhat');
const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');
const { toBytes32 } = require('../..');
const { toUnit } = require('../utils')();
const {
	setExchangeFeeRateForSynths,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');

const { setupAllContracts } = require('./setup');

contract('SynthUtil', accounts => {
	const [, ownerAccount, , account2] = accounts;
	let synthUtil, uUSDContract, tribeone, exchangeRates, systemSettings, debtCache, circuitBreaker;

	const [uUSD, sBTC, iBTC, HAKA] = ['uUSD', 'sBTC', 'iBTC', 'HAKA'].map(toBytes32);
	const synthKeys = [uUSD, sBTC, iBTC];
	const synthPrices = [toUnit('1'), toUnit('5000'), toUnit('5000')];

	before(async () => {
		({
			SynthUtil: synthUtil,
			SynthuUSD: uUSDContract,
			TribeOne: tribeone,
			ExchangeRates: exchangeRates,
			SystemSettings: systemSettings,
			CircuitBreaker: circuitBreaker,
			DebtCache: debtCache,
		} = await setupAllContracts({
			accounts,
			synths: ['uUSD', 'sBTC', 'iBTC'],
			contracts: [
				'SynthUtil',
				'TribeOne',
				'Exchanger',
				'ExchangeRates',
				'ExchangeState',
				'FeePoolEternalStorage',
				'SystemSettings',
				'DebtCache',
				'Issuer',
				'LiquidatorRewards',
				'CollateralManager',
				'CircuitBreaker',
				'RewardEscrowV2', // required for issuer._collateral to read collateral
			],
		}));

		await setupPriceAggregators(exchangeRates, ownerAccount, [sBTC, iBTC]);
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateAggregatorRates(
			exchangeRates,
			circuitBreaker,
			[sBTC, iBTC, HAKA],
			['5000', '5000', '0.2'].map(toUnit)
		);
		await debtCache.takeDebtSnapshot();

		// set a 0% default exchange fee rate for test purpose
		const exchangeFeeRate = toUnit('0');
		await setExchangeFeeRateForSynths({
			owner: ownerAccount,
			systemSettings,
			synthKeys,
			exchangeFeeRates: synthKeys.map(() => exchangeFeeRate),
		});
	});

	describe('given an instance', () => {
		const uUSDMinted = toUnit('10000');
		const amountToExchange = toUnit('50');
		const uUSDAmount = toUnit('100');
		beforeEach(async () => {
			await tribeone.issueSynths(uUSDMinted, {
				from: ownerAccount,
			});
			await uUSDContract.transfer(account2, uUSDAmount, { from: ownerAccount });
			await tribeone.exchange(uUSD, amountToExchange, sBTC, { from: account2 });
		});
		describe('totalSynthsInKey', () => {
			it('should return the total balance of synths into the specified currency key', async () => {
				assert.bnEqual(await synthUtil.totalSynthsInKey(account2, uUSD), uUSDAmount);
			});
		});
		describe('synthsBalances', () => {
			it('should return the balance and its value in uUSD for every synth in the wallet', async () => {
				const effectiveValue = await exchangeRates.effectiveValue(uUSD, amountToExchange, sBTC);
				assert.deepEqual(await synthUtil.synthsBalances(account2), [
					[uUSD, sBTC, iBTC],
					[toUnit('50'), effectiveValue, 0],
					[toUnit('50'), toUnit('50'), 0],
				]);
			});
		});
		describe('synthsRates', () => {
			it('should return the correct synth rates', async () => {
				assert.deepEqual(await synthUtil.synthsRates(), [synthKeys, synthPrices]);
			});
		});
		describe('synthsTotalSupplies', () => {
			it('should return the correct synth total supplies', async () => {
				const effectiveValue = await exchangeRates.effectiveValue(uUSD, amountToExchange, sBTC);
				assert.deepEqual(await synthUtil.synthsTotalSupplies(), [
					synthKeys,
					[uUSDMinted.sub(amountToExchange), effectiveValue, 0],
					[uUSDMinted.sub(amountToExchange), amountToExchange, 0],
				]);
			});
		});
	});
});
