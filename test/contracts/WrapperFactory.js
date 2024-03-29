'use strict';

const { contract, artifacts, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { toUnit } = require('../utils')();

const {
	ensureOnlyExpectedMutativeFunctions,
	onlyGivenAddressCanInvoke,
	getDecodedLogs,
	decodedEventEqual,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');

const { setupAllContracts } = require('./setup');

const { toBytes32 } = require('../..');
const { toBN } = require('web3-utils');

contract('WrapperFactory', async accounts => {
	const tribes = ['hUSD', 'hETH', 'ETH', 'wHAKA'];
	const [hETH, ETH] = ['hETH', 'ETH'].map(toBytes32);

	const [, owner, , , account1] = accounts;

	let addressResolver,
		flexibleStorage,
		systemSettings,
		feePool,
		exchangeRates,
		FEE_ADDRESS,
		hUSDTribe,
		wrapperFactory,
		weth;

	before(async () => {
		({
			AddressResolver: addressResolver,
			SystemSettings: systemSettings,
			FeePool: feePool,
			ExchangeRates: exchangeRates,
			WrapperFactory: wrapperFactory,
			TribehUSD: hUSDTribe,
			WETH: weth,
			FlexibleStorage: flexibleStorage,
		} = await setupAllContracts({
			accounts,
			tribes,
			contracts: [
				'Tribeone',
				'AddressResolver',
				'SystemStatus',
				'Issuer',
				'Depot',
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage',
				'DebtCache',
				'Exchanger',
				'WETH',
				'CollateralManager',
				'WrapperFactory',
			],
		}));

		FEE_ADDRESS = await feePool.FEE_ADDRESS();

		// Depot requires ETH rates
		await setupPriceAggregators(exchangeRates, owner, [hETH, ETH]);
		await updateAggregatorRates(exchangeRates, null, [hETH, ETH], ['1500', '1500'].map(toUnit));
	});

	addSnapshotBeforeRestoreAfterEach();

	it('ensure only expected functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: wrapperFactory.abi,
			hasFallback: true,
			ignoreParents: ['Owned', 'Pausable', 'MixinResolver', 'MixinSystemSettings'],
			expected: ['createWrapper', 'distributeFees'],
		});
	});

	describe('On deployment of Contract', async () => {
		let instance;
		beforeEach(async () => {
			instance = wrapperFactory;
		});

		it('should set constructor params on deployment', async () => {
			assert.equal(await instance.resolver(), addressResolver.address);
			assert.equal(await instance.owner(), owner);
		});

		it('should access its dependencies via the address resolver', async () => {
			assert.equal(
				await addressResolver.getAddress(toBytes32('FlexibleStorage')),
				flexibleStorage.address
			);
		});

		it('should not be payable', async () => {
			await assert.revert(
				web3.eth.sendTransaction({
					value: toUnit('1'),
					from: owner,
					to: instance.address,
				}),
				'Contract is not payable'
			);
		});
	});

	describe('createWrapper', async () => {
		it('only owner can invoke', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: systemSettings.setCrossDomainMessageGasLimit,
				args: [0, 4e6],
				accounts,
				address: owner,
				reason: 'Only the contract owner may perform this action',
			});
		});

		describe('when successfully invoked', () => {
			let createdWrapperAddress;
			let txn;

			before(async () => {
				txn = await wrapperFactory.createWrapper(weth.address, hETH, toBytes32('TribehETH'), {
					from: owner,
				});
			});

			it('emits new wrapper contract address', async () => {
				// extract address from events
				createdWrapperAddress = txn.logs.find(l => l.event === 'WrapperCreated').args
					.wrapperAddress;

				assert.isOk(createdWrapperAddress);
			});

			it('created wrapper has rebuilt cache', async () => {
				const etherWrapper = await artifacts.require('Wrapper').at(createdWrapperAddress);

				// call totalIssuedTribes because it depends on address for ExchangeRates
				await etherWrapper.totalIssuedTribes();
			});

			it('registers to isWrapper', async () => {
				assert.isOk(await wrapperFactory.isWrapper(createdWrapperAddress));
			});
		});
	});

	describe('totalIssuedTribes', async () => {});

	describe('distributeFees', async () => {
		let tx;
		let feesEscrowed;
		let etherWrapper;

		before(async () => {
			// deploy a wrapper
			const txn = await wrapperFactory.createWrapper(weth.address, hETH, toBytes32('TribehETH'), {
				from: owner,
			});

			const createdWrapperAddress = txn.logs.find(l => l.event === 'WrapperCreated').args
				.wrapperAddress;

			etherWrapper = await artifacts.require('Wrapper').at(createdWrapperAddress);

			const amount = toUnit('10');
			await systemSettings.setWrapperMaxTokenAmount(createdWrapperAddress, amount, { from: owner });
			await systemSettings.setWrapperMintFeeRate(createdWrapperAddress, toUnit('0.005'), {
				from: owner,
			});
			await weth.deposit({ from: account1, value: amount });
			await weth.approve(etherWrapper.address, amount, { from: account1 });
			await etherWrapper.mint(amount, { from: account1 });

			feesEscrowed = await wrapperFactory.feesEscrowed();
			tx = await wrapperFactory.distributeFees();
		});

		it('issues hUSD to the feepool', async () => {
			const logs = await getDecodedLogs({
				hash: tx.tx,
				contracts: [hUSDTribe],
			});

			// sanity
			assert.bnGt(feesEscrowed, toUnit('0'));

			decodedEventEqual({
				event: 'Transfer',
				emittedFrom: await hUSDTribe.proxy(),
				args: [wrapperFactory.address, FEE_ADDRESS, feesEscrowed],
				log: logs
					.reverse()
					.filter(l => !!l)
					.find(({ name }) => name === 'Transfer'),
			});
		});

		it('records fee paid', async () => {
			const recentFeePeriod = await feePool.recentFeePeriods(0);

			assert.bnNotEqual(toUnit(0), feesEscrowed); // because i'm paranoid
			assert.bnEqual(recentFeePeriod.feesToDistribute, feesEscrowed);
		});

		it('feesEscrowed = 0', async () => {
			assert.bnEqual(await wrapperFactory.feesEscrowed(), toBN(0));
		});
	});
});
