'use strict';

const { contract, artifacts } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { setupAllContracts, setupContract, mockToken } = require('./setup');

const { currentTime, toUnit, fastForward, multiplyDecimalRound } = require('../utils')();

const {
	setExchangeFeeRateForTribes,
	getDecodedLogs,
	decodedEventEqual,
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	setStatus,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('./helpers');

const {
	toBytes32,
	defaults: { DEBT_SNAPSHOT_STALE_TIME },
	constants: { ZERO_ADDRESS },
} = require('../..');

contract('DebtCache', async accounts => {
	const [hUSD, sAUD, sEUR, wHAKA, hETH, ETH, iETH] = [
		'hUSD',
		'sAUD',
		'sEUR',
		'wHAKA',
		'hETH',
		'ETH',
		'iETH',
	].map(toBytes32);
	const tribeKeys = [hUSD, sAUD, sEUR, hETH, wHAKA];

	const [deployerAccount, owner, , account1] = accounts;

	const oneETH = toUnit('1.0');
	const twoETH = toUnit('2.0');

	let tribeone,
		tribeetixProxy,
		systemStatus,
		systemSettings,
		exchangeRates,
		circuitBreaker,
		feePool,
		hUSDContract,
		hETHContract,
		sEURContract,
		sAUDContract,
		debtCache,
		issuer,
		tribes,
		addressResolver,
		exchanger,
		// Futures market
		futuresMarketManager,
		wrapperFactory,
		weth,
		// MultiCollateral tests.
		ceth,
		// Short tests.
		short,
		// aggregators
		aggregatorDebtRatio,
		aggregatorIssuedTribes;

	const deployCollateral = async ({ owner, manager, resolver, collatKey, minColat, minSize }) => {
		return setupContract({
			accounts,
			contract: 'CollateralEth',
			args: [owner, manager, resolver, collatKey, minColat, minSize],
		});
	};

	const setupMultiCollateral = async () => {
		const CollateralManager = artifacts.require(`CollateralManager`);
		const CollateralManagerState = artifacts.require('CollateralManagerState');

		tribes = ['hUSD', 'hETH', 'sAUD'];

		// Deploy CollateralManagerState.
		const managerState = await CollateralManagerState.new(owner, ZERO_ADDRESS, {
			from: deployerAccount,
		});

		const maxDebt = toUnit(10000000);

		// Deploy CollateralManager.
		const manager = await CollateralManager.new(
			managerState.address,
			owner,
			addressResolver.address,
			maxDebt,
			0,
			0,
			0,
			{
				from: deployerAccount,
			}
		);

		await managerState.setAssociatedContract(manager.address, { from: owner });

		// Deploy ETH Collateral.
		ceth = await deployCollateral({
			owner: owner,
			manager: manager.address,
			resolver: addressResolver.address,
			collatKey: hETH,
			minColat: toUnit('1.3'),
			minSize: toUnit('2'),
		});

		await addressResolver.importAddresses(
			[toBytes32('CollateralEth'), toBytes32('CollateralManager')],
			[ceth.address, manager.address],
			{
				from: owner,
			}
		);

		await ceth.rebuildCache();
		await manager.rebuildCache();
		await debtCache.rebuildCache();
		await feePool.rebuildCache();
		await issuer.rebuildCache();
		await wrapperFactory.rebuildCache();

		await manager.addCollaterals([ceth.address], { from: owner });

		await ceth.addTribes(
			['TribehUSD', 'TribehETH'].map(toBytes32),
			['hUSD', 'hETH'].map(toBytes32),
			{ from: owner }
		);

		await manager.addTribes(
			['TribehUSD', 'TribehETH'].map(toBytes32),
			['hUSD', 'hETH'].map(toBytes32),
			{ from: owner }
		);
		// rebuild the cache to add the tribes we need.
		await manager.rebuildCache();

		// Set fees to 0.
		await ceth.setIssueFeeRate(toUnit('0'), { from: owner });
		await systemSettings.setExchangeFeeRateForTribes(
			tribes.map(toBytes32),
			tribes.map(s => toUnit('0')),
			{ from: owner }
		);
	};

	const deployShort = async ({ owner, manager, resolver, collatKey, minColat, minSize }) => {
		return setupContract({
			accounts,
			contract: 'CollateralShort',
			args: [owner, manager, resolver, collatKey, minColat, minSize],
		});
	};

	const setupShort = async () => {
		const CollateralManager = artifacts.require(`CollateralManager`);
		const CollateralManagerState = artifacts.require('CollateralManagerState');

		const managerState = await CollateralManagerState.new(owner, ZERO_ADDRESS, {
			from: deployerAccount,
		});

		const maxDebt = toUnit(10000000);

		const manager = await CollateralManager.new(
			managerState.address,
			owner,
			addressResolver.address,
			maxDebt,
			0,
			// 5% / 31536000 (seconds in common year)
			1585489599,
			0,
			{
				from: deployerAccount,
			}
		);

		await managerState.setAssociatedContract(manager.address, { from: owner });

		short = await deployShort({
			owner: owner,
			manager: manager.address,
			resolver: addressResolver.address,
			collatKey: hUSD,
			minColat: toUnit(1.2),
			minSize: toUnit(0.1),
		});

		await addressResolver.importAddresses(
			[toBytes32('CollateralShort'), toBytes32('CollateralManager')],
			[short.address, manager.address],
			{
				from: owner,
			}
		);

		await feePool.rebuildCache();
		await manager.rebuildCache();
		await issuer.rebuildCache();
		await debtCache.rebuildCache();

		await manager.addCollaterals([short.address], { from: owner });

		await short.addTribes(['TribehETH'].map(toBytes32), ['hETH'].map(toBytes32), { from: owner });

		await manager.addShortableTribes(['TribehETH'].map(toBytes32), [hETH], {
			from: owner,
		});

		await hUSDContract.approve(short.address, toUnit(100000), { from: account1 });
	};

	const setupDebtIssuer = async () => {
		const etherWrapperCreateTx = await wrapperFactory.createWrapper(
			weth.address,
			hETH,
			toBytes32('TribehETH'),
			{ from: owner }
		);

		// extract address from events
		const etherWrapperAddress = etherWrapperCreateTx.logs.find(l => l.event === 'WrapperCreated')
			.args.wrapperAddress;

		await systemSettings.setWrapperMaxTokenAmount(etherWrapperAddress, toUnit('1000000'), {
			from: owner,
		});

		return artifacts.require('Wrapper').at(etherWrapperAddress);
	};

	// run this once before all tests to prepare our environment, snapshots on beforeEach will take
	// care of resetting to this state
	before(async () => {
		tribes = ['hUSD', 'sAUD', 'sEUR', 'hETH', 'iETH'];
		({
			Tribeone: tribeone,
			ProxyERC20Tribeone: tribeetixProxy,
			SystemStatus: systemStatus,
			SystemSettings: systemSettings,
			ExchangeRates: exchangeRates,
			CircuitBreaker: circuitBreaker,
			TribehUSD: hUSDContract,
			TribehETH: hETHContract,
			TribesAUD: sAUDContract,
			TribesEUR: sEURContract,
			FeePool: feePool,
			DebtCache: debtCache,
			Issuer: issuer,
			AddressResolver: addressResolver,
			Exchanger: exchanger,
			FuturesMarketManager: futuresMarketManager,
			WrapperFactory: wrapperFactory,
			WETH: weth,
			'ext:AggregatorDebtRatio': aggregatorDebtRatio,
			'ext:AggregatorIssuedTribes': aggregatorIssuedTribes,
		} = await setupAllContracts({
			accounts,
			tribes,
			contracts: [
				'Tribeone',
				'ExchangeRates',
				'CircuitBreaker',
				'FeePool',
				'FeePoolEternalStorage',
				'AddressResolver',
				'RewardEscrow',
				'TribeoneEscrow',
				'SystemSettings',
				'Issuer',
				'LiquidatorRewards',
				'DebtCache',
				'Exchanger', // necessary for burnTribes to check settlement of hUSD
				'DelegateApprovals', // necessary for *OnBehalf functions
				'FlexibleStorage',
				'CollateralManager',
				'RewardEscrowV2', // necessary for issuer._collateral()
				'CollateralUtil',
				'FuturesMarketManager',
				'WrapperFactory',
				'WETH',
			],
		}));

		// use implementation ABI on the proxy address to simplify calling
		tribeone = await artifacts.require('Tribeone').at(tribeetixProxy.address);

		await setupPriceAggregators(exchangeRates, owner, [sAUD, sEUR, hETH, ETH, iETH]);
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateAggregatorRates(
			exchangeRates,
			circuitBreaker,
			[sAUD, sEUR, wHAKA, hETH, ETH, iETH],
			['0.5', '1.25', '10', '200', '200', '200'].map(toUnit)
		);

		const exchangeFeeRate = toUnit('0.003');
		await setExchangeFeeRateForTribes({
			owner,
			systemSettings,
			tribeKeys,
			exchangeFeeRates: tribeKeys.map(() => exchangeFeeRate),
		});
		await debtCache.takeDebtSnapshot();
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: debtCache.abi,
			ignoreParents: ['Owned', 'MixinResolver'],
			expected: [
				'takeDebtSnapshot',
				'recordExcludedDebtChange',
				'purgeCachedTribeDebt',
				'updateCachedTribeDebts',
				'updateCachedTribeDebtWithRate',
				'updateCachedTribeDebtsWithRates',
				'updateDebtCacheValidity',
				'updateCachedhUSDDebt',
				'importExcludedIssuedDebts',
			],
		});
	});

	it('debt snapshot stale time is correctly configured as a default', async () => {
		assert.bnEqual(await debtCache.debtSnapshotStaleTime(), DEBT_SNAPSHOT_STALE_TIME);
	});

	describe('protected methods', () => {
		it('updateCachedTribeDebtWithRate() can only be invoked by the issuer', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: debtCache.updateCachedTribeDebtWithRate,
				args: [sAUD, toUnit('1')],
				accounts,
				reason: 'Sender is not Issuer',
			});
		});

		it('updateCachedTribeDebtsWithRates() can only be invoked by the issuer or exchanger', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: debtCache.updateCachedTribeDebtsWithRates,
				args: [
					[sAUD, sEUR],
					[toUnit('1'), toUnit('2')],
				],
				accounts,
				reason: 'Sender is not Issuer or Exchanger',
			});
		});

		it('updateDebtCacheValidity() can only be invoked by the issuer', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: debtCache.updateDebtCacheValidity,
				args: [true],
				accounts,
				reason: 'Sender is not Issuer',
			});
		});

		it('purgeCachedTribeDebt() can only be invoked by the owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: debtCache.purgeCachedTribeDebt,
				accounts,
				args: [sAUD],
				address: owner,
				skipPassCheck: true,
				reason: 'Only the contract owner may perform this action',
			});
		});

		it('importExcludedIssuedDebts() can only be invoked by the owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: debtCache.importExcludedIssuedDebts,
				accounts,
				args: [ZERO_ADDRESS, ZERO_ADDRESS],
				address: owner,
				skipPassCheck: true,
				reason: 'Only the contract owner may perform this action',
			});
		});

		it('recordExcludedDebtChange() can only be invoked by the owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: debtCache.recordExcludedDebtChange,
				accounts,
				args: [sAUD, toUnit('1')],
				address: owner,
				skipPassCheck: true,
				reason: 'Only debt issuers may call this',
			});
		});

		it('updateCachedhUSDDebt() can only be invoked by the issuer', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: debtCache.updateCachedhUSDDebt,
				args: [toUnit('1')],
				accounts,
				reason: 'Sender is not Issuer',
			});
		});
	});

	describe('After issuing tribes', () => {
		beforeEach(async () => {
			// set minimumStakeTime on issue and burning to 0
			await systemSettings.setMinimumStakeTime(0, { from: owner });
			// set default issuance ratio of 0.2
			await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
			// set up initial prices
			await updateAggregatorRates(
				exchangeRates,
				circuitBreaker,
				[sAUD, sEUR, hETH],
				['0.5', '2', '100'].map(toUnit)
			);
			await debtCache.takeDebtSnapshot();

			// Issue 1000 hUSD worth of tokens to a user
			await hUSDContract.issue(account1, toUnit(100));
			await sAUDContract.issue(account1, toUnit(100));
			await sEURContract.issue(account1, toUnit(100));
			await hETHContract.issue(account1, toUnit(2));
		});

		describe('Current issued debt', () => {
			it('Live debt is reported accurately', async () => {
				// The tribe debt has not yet been cached.
				assert.bnEqual((await debtCache.cacheInfo()).debt, toUnit(0));

				const result = await debtCache.currentDebt();
				assert.bnEqual(result[0], toUnit(550));
				assert.isFalse(result[1]);
			});

			it('Live debt is reported accurately for individual currencies', async () => {
				const result = await debtCache.currentTribeDebts([hUSD, sEUR, sAUD, hETH]);
				const debts = result[0];

				assert.bnEqual(debts[0], toUnit(100));
				assert.bnEqual(debts[1], toUnit(200));
				assert.bnEqual(debts[2], toUnit(50));
				assert.bnEqual(debts[3], toUnit(200));

				assert.isFalse(result[3]);
			});
		});

		describe('takeDebtSnapshot()', () => {
			let preTimestamp;
			let tx;
			let time;

			beforeEach(async () => {
				preTimestamp = (await debtCache.cacheInfo()).timestamp;
				await fastForward(5);
				tx = await debtCache.takeDebtSnapshot();
				time = await currentTime();
			});

			it('accurately resynchronises the debt after prices have changed', async () => {
				assert.bnEqual((await debtCache.cacheInfo()).debt, toUnit(550));
				let result = await debtCache.currentDebt();
				assert.bnEqual(result[0], toUnit(550));
				assert.isFalse(result[1]);

				await updateAggregatorRates(
					exchangeRates,
					circuitBreaker,
					[sAUD, sEUR],
					['1', '3'].map(toUnit)
				);
				await debtCache.takeDebtSnapshot();
				assert.bnEqual((await debtCache.cacheInfo()).debt, toUnit(700));
				result = await debtCache.currentDebt();
				assert.bnEqual(result[0], toUnit(700));
				assert.isFalse(result[1]);
			});

			it('updates the debt snapshot timestamp', async () => {
				const timestamp = (await debtCache.cacheInfo()).timestamp;
				assert.bnNotEqual(timestamp, preTimestamp);
				assert.isTrue(time - timestamp < 15);
			});

			it('properly emits debt cache updated and synchronised events', async () => {
				assert.eventEqual(tx.logs[0], 'DebtCacheUpdated', [toUnit(550)]);
				assert.eventEqual(tx.logs[1], 'DebtCacheSnapshotTaken', [
					(await debtCache.cacheInfo()).timestamp,
				]);
			});

			it('updates the cached values for all individual tribes', async () => {
				await updateAggregatorRates(
					exchangeRates,
					circuitBreaker,
					[sAUD, sEUR, hETH],
					['1', '3', '200'].map(toUnit)
				);
				await debtCache.takeDebtSnapshot();
				let debts = await debtCache.currentTribeDebts([hUSD, sEUR, sAUD, hETH]);
				assert.bnEqual(debts[0][0], toUnit(100));
				assert.bnEqual(debts[0][1], toUnit(300));
				assert.bnEqual(debts[0][2], toUnit(100));
				assert.bnEqual(debts[0][3], toUnit(400));

				debts = await debtCache.cachedTribeDebts([hUSD, sEUR, sAUD, hETH]);
				assert.bnEqual(debts[0], toUnit(100));
				assert.bnEqual(debts[1], toUnit(300));
				assert.bnEqual(debts[2], toUnit(100));
				assert.bnEqual(debts[3], toUnit(400));
			});

			it('is able to invalidate and revalidate the debt cache when required.', async () => {
				// Wait until the exchange rates are stale in order to invalidate the cache.
				const rateStalePeriod = await systemSettings.rateStalePeriod();
				await fastForward(rateStalePeriod + 1000);

				assert.isFalse((await debtCache.cacheInfo()).isInvalid);

				// stale rates invalidate the cache
				const tx1 = await debtCache.takeDebtSnapshot();
				assert.isTrue((await debtCache.cacheInfo()).isInvalid);

				// Revalidate the cache once rates are no longer stale
				await updateAggregatorRates(
					exchangeRates,
					circuitBreaker,
					[sAUD, sEUR, wHAKA, hETH, ETH, iETH],
					['0.5', '2', '100', '200', '200', '200'].map(toUnit)
				);
				const tx2 = await debtCache.takeDebtSnapshot();
				assert.isFalse((await debtCache.cacheInfo()).isInvalid);

				assert.eventEqual(tx1.logs[2], 'DebtCacheValidityChanged', [true]);
				assert.eventEqual(tx2.logs[2], 'DebtCacheValidityChanged', [false]);
			});

			it('will not operate if the system is paused except by the owner', async () => {
				await setStatus({ owner, systemStatus, section: 'System', suspend: true });
				await assert.revert(
					debtCache.takeDebtSnapshot({ from: account1 }),
					'Tribeone is suspended'
				);
				await debtCache.takeDebtSnapshot({ from: owner });
			});

			describe('properly incorporates futures market debt', () => {
				it('when no market exist', async () => {
					await debtCache.takeDebtSnapshot();
					const initialDebt = (await debtCache.cacheInfo()).debt;

					// issue some debt to sanity check it's being updated
					hUSDContract.issue(account1, toUnit(100), { from: owner });
					await debtCache.takeDebtSnapshot();

					// debt calc works
					assert.bnEqual((await debtCache.currentDebt())[0], initialDebt.add(toUnit(100)));
					assert.bnEqual((await debtCache.cacheInfo()).debt, initialDebt.add(toUnit(100)));

					// no debt from futures
					assert.bnEqual((await debtCache.currentTribeDebts([])).futuresDebt, toUnit(0));
				});

				it('when a market exists', async () => {
					const market = await setupContract({
						accounts,
						contract: 'MockFuturesMarket',
						args: [
							futuresMarketManager.address,
							toBytes32('sLINK'),
							toBytes32('sLINK'),
							toUnit('1000'),
							false,
						],
						skipPostDeploy: true,
					});
					await futuresMarketManager.addMarkets([market.address], { from: owner });

					await debtCache.takeDebtSnapshot();
					const initialDebt = (await debtCache.cacheInfo()).debt;
					await market.setMarketDebt(toUnit('2000'));
					await debtCache.takeDebtSnapshot();

					assert.bnEqual((await debtCache.cacheInfo()).debt, initialDebt.add(toUnit('1000')));
					assert.bnEqual((await debtCache.currentTribeDebts([])).futuresDebt, toUnit('2000'));
				});
			});

			describe('when debts are excluded', async () => {
				let beforeExcludedDebts;

				beforeEach(async () => {
					beforeExcludedDebts = await debtCache.currentDebt();

					// cause debt CollateralManager
					await setupMultiCollateral();
					await ceth.open(oneETH, hETH, {
						value: toUnit('10'),
						from: account1,
					});

					// cause debt from WrapperFactory
					const etherWrapper = await setupDebtIssuer();
					const wrapperAmount = toUnit('1');

					await weth.deposit({ from: account1, value: wrapperAmount });
					await weth.approve(etherWrapper.address, wrapperAmount, { from: account1 });
					await etherWrapper.mint(wrapperAmount, { from: account1 });

					// test function
					await debtCache.takeDebtSnapshot({ from: owner });
				});

				it('current debt is correct', async () => {
					// debt shouldn't have changed since wHAKA holders have not issued any more debt
					assert.bnEqual(await debtCache.currentDebt(), beforeExcludedDebts);
				});
			});
		});

		describe('cache functions', () => {
			let originalTimestamp;

			it('values are correct', async () => {
				originalTimestamp = await debtCache.cacheTimestamp();
				assert.bnNotEqual(originalTimestamp, 0);
				assert.equal(await debtCache.cacheInvalid(), false);
				assert.equal(await debtCache.cacheStale(), false);
			});

			describe('after going forward in time', () => {
				beforeEach(async () => {
					await fastForward(1000000);
				});

				it('is now stale', async () => {
					assert.equal(await debtCache.cacheInvalid(), false);
					assert.equal(await debtCache.cacheStale(), true);
				});

				describe('debt snapshot is taken', () => {
					beforeEach(async () => {
						await debtCache.takeDebtSnapshot();
					});

					it('is now invalid (upstream rates are ood)', async () => {
						assert.bnNotEqual(await debtCache.cacheTimestamp(), originalTimestamp);
						assert.equal(await debtCache.cacheInvalid(), true);
						assert.equal(await debtCache.cacheStale(), false);
					});
				});
			});
		});

		describe('updateCachedTribeDebts()', () => {
			it('allows resynchronisation of subsets of tribes', async () => {
				await debtCache.takeDebtSnapshot();

				await updateAggregatorRates(
					exchangeRates,
					circuitBreaker,
					[sAUD, sEUR, hETH],
					['1', '3', '200'].map(toUnit)
				);

				// First try a single currency, ensuring that the others have not been altered.
				const expectedDebts = (await debtCache.currentTribeDebts([sAUD, sEUR, hETH]))[0];

				await debtCache.updateCachedTribeDebts([sAUD]);
				assert.bnEqual(await issuer.totalIssuedTribes(hUSD, true), toUnit(600));
				let debts = await debtCache.cachedTribeDebts([sAUD, sEUR, hETH]);

				assert.bnEqual(debts[0], expectedDebts[0]);
				assert.bnEqual(debts[1], toUnit(200));
				assert.bnEqual(debts[2], toUnit(200));

				// Then a subset
				await debtCache.updateCachedTribeDebts([sEUR, hETH]);
				assert.bnEqual(await issuer.totalIssuedTribes(hUSD, true), toUnit(900));
				debts = await debtCache.cachedTribeDebts([sEUR, hETH]);
				assert.bnEqual(debts[0], expectedDebts[1]);
				assert.bnEqual(debts[1], expectedDebts[2]);
			});

			it('can invalidate the debt cache for individual currencies with invalid rates', async () => {
				// Wait until the exchange rates are stale in order to invalidate the cache.
				const rateStalePeriod = await systemSettings.rateStalePeriod();
				await fastForward(rateStalePeriod + 1000);

				assert.isFalse((await debtCache.cacheInfo()).isInvalid);

				// individual stale rates invalidate the cache
				const tx1 = await debtCache.updateCachedTribeDebts([sAUD]);
				assert.isTrue((await debtCache.cacheInfo()).isInvalid);

				// But even if we update all rates, we can't revalidate the cache using the partial update function
				await updateAggregatorRates(
					exchangeRates,
					circuitBreaker,
					[sAUD, sEUR, hETH],
					['0.5', '2', '100'].map(toUnit)
				);
				const tx2 = await debtCache.updateCachedTribeDebts([sAUD, sEUR, hETH]);
				assert.isTrue((await debtCache.cacheInfo()).isInvalid);
				assert.eventEqual(tx1.logs[1], 'DebtCacheValidityChanged', [true]);
				assert.isTrue(tx2.logs.find(log => log.event === 'DebtCacheValidityChanged') === undefined);
			});

			it('properly emits events', async () => {
				await debtCache.takeDebtSnapshot();

				await updateAggregatorRates(
					exchangeRates,
					circuitBreaker,
					[sAUD, sEUR, hETH],
					['1', '3', '200'].map(toUnit)
				);

				const tx = await debtCache.updateCachedTribeDebts([sAUD]);
				assert.eventEqual(tx.logs[0], 'DebtCacheUpdated', [toUnit(600)]);
			});

			it('reverts when attempting to synchronise non-existent tribes or wHAKA', async () => {
				await assert.revert(debtCache.updateCachedTribeDebts([wHAKA]));
				const fakeTribe = toBytes32('FAKE');
				await assert.revert(debtCache.updateCachedTribeDebts([fakeTribe]));
				await assert.revert(debtCache.updateCachedTribeDebts([hUSD, fakeTribe]));
			});

			it('will not operate if the system is paused except for the owner', async () => {
				await setStatus({ owner, systemStatus, section: 'System', suspend: true });
				await assert.revert(
					debtCache.updateCachedTribeDebts([sAUD, sEUR], { from: account1 }),
					'Tribeone is suspended'
				);
				await debtCache.updateCachedTribeDebts([sAUD, sEUR], { from: owner });
			});
		});

		describe('recordExcludedDebtChange()', () => {
			it('does not work if delta causes excludedDebt goes negative', async () => {
				await assert.revert(
					debtCache.recordExcludedDebtChange(hETH, toUnit('-1'), { from: owner }),
					'Excluded debt cannot become negative'
				);
			});

			it('executed successfully', async () => {
				await debtCache.recordExcludedDebtChange(hETH, toUnit('1'), { from: owner });
				assert.bnEqual(await debtCache.excludedIssuedDebts([hETH]), toUnit('1'));

				await debtCache.recordExcludedDebtChange(hETH, toUnit('-0.2'), { from: owner });
				assert.bnEqual(await debtCache.excludedIssuedDebts([hETH]), toUnit('0.8'));
			});
		});

		describe('importExcludedIssuedDebts()', () => {
			beforeEach(async () => {
				await debtCache.recordExcludedDebtChange(hETH, toUnit('1'), { from: owner });
				await debtCache.recordExcludedDebtChange(sAUD, toUnit('2'), { from: owner });
			});

			it('reverts for non debt cache address', async () => {
				await assert.revert(
					debtCache.importExcludedIssuedDebts(issuer.address, issuer.address, { from: owner })
				);
			});

			it('reverts for non issuer address', async () => {
				await assert.revert(
					debtCache.importExcludedIssuedDebts(debtCache.address, debtCache.address, { from: owner })
				);
			});

			it('reverts for empty issuer', async () => {
				const newIssuer = await setupContract({
					contract: 'Issuer',
					accounts,
					skipPostDeploy: true,
					args: [owner, addressResolver.address],
				});

				await assert.revert(
					debtCache.importExcludedIssuedDebts(debtCache.address, newIssuer.address, {
						from: owner,
					}),
					'previous Issuer has no tribes'
				);
			});

			it('imports previous entries and can run only once', async () => {
				const newIssuer = await setupContract({
					contract: 'Issuer',
					accounts,
					skipPostDeploy: true,
					args: [owner, addressResolver.address],
				});
				const newDebtCache = await setupContract({
					contract: 'DebtCache',
					accounts,
					skipPostDeploy: true,
					args: [owner, addressResolver.address],
				});

				// update the address resolver and the contract address caches
				await addressResolver.importAddresses(
					[toBytes32('Issuer'), toBytes32('DebtCache')],
					[newIssuer.address, newDebtCache.address],
					{ from: owner }
				);
				await newIssuer.rebuildCache();
				await newDebtCache.rebuildCache();

				// add only one of the tribes
				await newIssuer.addTribe(hETHContract.address, { from: owner });

				// check uninitialised
				assert.equal(await newDebtCache.isInitialized(), false);

				// import entries
				await newDebtCache.importExcludedIssuedDebts(debtCache.address, issuer.address, {
					from: owner,
				});

				// check initialised
				assert.equal(await newDebtCache.isInitialized(), true);

				// check both entries are updated
				// sAUD is not in new Issuer, but should be imported
				assert.bnEqual(await debtCache.excludedIssuedDebts([hETH, sAUD]), [
					toUnit('1'),
					toUnit('2'),
				]);

				// check can't run twice
				await assert.revert(
					newDebtCache.importExcludedIssuedDebts(debtCache.address, issuer.address, {
						from: owner,
					}),
					'already initialized'
				);
			});
		});

		describe('updateCachedhUSDDebt()', () => {
			beforeEach(async () => {
				await addressResolver.importAddresses([toBytes32('Issuer')], [owner], {
					from: owner,
				});
				await debtCache.rebuildCache();
			});
			it('when hUSD is increased by minting', async () => {
				const cachedTribeDebt = (await debtCache.cachedTribeDebts([hUSD]))[0];
				const amount = toUnit('1000');
				const tx = await debtCache.updateCachedhUSDDebt(amount, { from: owner });

				assert.bnEqual((await debtCache.cacheInfo())[0], cachedTribeDebt.add(amount));
				assert.bnEqual(await debtCache.cachedTribeDebts([hUSD]), cachedTribeDebt.add(amount));

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [cachedTribeDebt.add(amount)],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});
			it('when hUSD cache is decreased by minting', async () => {
				const amount = toUnit('1000');
				await debtCache.updateCachedhUSDDebt(amount, { from: owner });

				// cached Tribe after increase
				const cachedTribeDebt = (await debtCache.cachedTribeDebts([hUSD]))[0];
				assert.bnEqual((await debtCache.cacheInfo())[0], amount);
				assert.bnEqual(await debtCache.cachedTribeDebts([hUSD]), amount);

				// decrease the cached hUSD amount
				const amountToReduce = toUnit('500');
				const tx = await debtCache.updateCachedhUSDDebt(amountToReduce.neg(), { from: owner });

				assert.bnEqual(
					await debtCache.cachedTribeDebts([hUSD]),
					cachedTribeDebt.sub(amountToReduce)
				);

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [cachedTribeDebt.sub(amountToReduce)],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});
		});

		describe('Issuance, burning, exchange, settlement', () => {
			it('issuing hUSD updates the debt total', async () => {
				await debtCache.takeDebtSnapshot();
				const issued = (await debtCache.cacheInfo())[0];

				const tribesToIssue = toUnit('10');
				await tribeone.transfer(account1, toUnit('1000'), { from: owner });
				const tx = await tribeone.issueTribes(tribesToIssue, { from: account1 });
				assert.bnEqual((await debtCache.cacheInfo())[0], issued.add(tribesToIssue));

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [issued.add(tribesToIssue)],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});

			it('burning hUSD updates the debt total', async () => {
				await debtCache.takeDebtSnapshot();
				const tribesToIssue = toUnit('10');
				await tribeone.transfer(account1, toUnit('1000'), { from: owner });
				await tribeone.issueTribes(tribesToIssue, { from: account1 });

				await circuitBreaker.resetLastValue(
					[aggregatorIssuedTribes.address, aggregatorDebtRatio.address],
					[
						(await aggregatorIssuedTribes.latestRoundData())[1],
						(await aggregatorDebtRatio.latestRoundData())[1],
					],
					{ from: owner }
				);

				const issued = (await debtCache.cacheInfo())[0];

				const tribesToBurn = toUnit('5');

				const tx = await tribeone.burnTribes(tribesToBurn, { from: account1 });
				assert.bnEqual((await debtCache.cacheInfo())[0], issued.sub(tribesToBurn));

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [issued.sub(tribesToBurn)],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});

			it('issuing hUSD updates the total debt cached and hUSD cache', async () => {
				await debtCache.takeDebtSnapshot();
				const issued = (await debtCache.cacheInfo())[0];

				const tribesToIssue = toUnit('1000');
				const cachedTribes = (await debtCache.cachedTribeDebts([hUSD]))[0];

				await tribeone.transfer(account1, toUnit('10000'), { from: owner });

				const tx = await tribeone.issueTribes(tribesToIssue, { from: account1 });

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [issued.add(tribesToIssue)],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});

				// cached hUSD increased by tribe issued
				assert.bnEqual(await debtCache.cachedTribeDebts([hUSD]), cachedTribes.add(tribesToIssue));
				assert.bnEqual((await debtCache.cacheInfo())[0], issued.add(tribesToIssue));
			});

			it('burning hUSD reduces the total debt and hUSD cache', async () => {
				await debtCache.takeDebtSnapshot();

				const tribesToIssue = toUnit('1000');
				await tribeone.transfer(account1, toUnit('10000'), { from: owner });
				await tribeone.issueTribes(tribesToIssue, { from: account1 });

				const cachedTribes = (await debtCache.cachedTribeDebts([hUSD]))[0];
				const issued = (await debtCache.cacheInfo())[0];
				const tribesToBurn = toUnit('500');

				const tx = await tribeone.burnTribes(tribesToBurn, { from: account1 });

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [issued.sub(tribesToBurn)],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});

				// cached hUSD decreased by tribe burned
				assert.bnEqual(await debtCache.cachedTribeDebts([hUSD]), cachedTribes.sub(tribesToBurn));
				assert.bnEqual((await debtCache.cacheInfo())[0], issued.sub(tribesToBurn));
			});

			it('exchanging between tribes updates the debt totals for those tribes', async () => {
				// Zero exchange fees so that we can neglect them.
				await systemSettings.setExchangeFeeRateForTribes([sAUD, hUSD], [toUnit(0), toUnit(0)], {
					from: owner,
				});

				await debtCache.takeDebtSnapshot();
				await tribeone.transfer(account1, toUnit('1000'), { from: owner });
				await tribeone.issueTribes(toUnit('10'), { from: account1 });
				const issued = (await debtCache.cacheInfo())[0];
				const debts = await debtCache.cachedTribeDebts([hUSD, sAUD]);
				const tx = await tribeone.exchange(hUSD, toUnit('5'), sAUD, { from: account1 });
				const postDebts = await debtCache.cachedTribeDebts([hUSD, sAUD]);
				assert.bnEqual((await debtCache.cacheInfo())[0], issued);
				assert.bnEqual(postDebts[0], debts[0].sub(toUnit(5)));
				assert.bnEqual(postDebts[1], debts[1].add(toUnit(5)));

				// As the total debt did not change, no DebtCacheUpdated event was emitted.
				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				assert.isUndefined(logs.find(({ name } = {}) => name === 'DebtCacheUpdated'));
			});

			it('exchanging between tribes updates hUSD debt total due to fees', async () => {
				// Disable Dynamic fee so that we can neglect it.
				await systemSettings.setExchangeDynamicFeeRounds('0', { from: owner });

				await systemSettings.setExchangeFeeRateForTribes(
					[sAUD, hUSD, sEUR],
					[toUnit(0.05), toUnit(0.05), toUnit(0.05)],
					{ from: owner }
				);

				await sEURContract.issue(account1, toUnit(20));
				await debtCache.takeDebtSnapshot();
				const issued = (await debtCache.cacheInfo())[0];

				const debts = await debtCache.cachedTribeDebts([hUSD, sAUD, sEUR]);

				await tribeone.exchange(sEUR, toUnit(10), sAUD, { from: account1 });
				const postDebts = await debtCache.cachedTribeDebts([hUSD, sAUD, sEUR]);

				assert.bnEqual((await debtCache.cacheInfo())[0], issued);
				assert.bnEqual(postDebts[0], debts[0].add(toUnit(2)));
				assert.bnEqual(postDebts[1], debts[1].add(toUnit(18)));
				assert.bnEqual(postDebts[2], debts[2].sub(toUnit(20)));
			});

			it('exchanging between tribes updates debt properly when prices have changed', async () => {
				// Zero exchange fees so that we can neglect them.
				await systemSettings.setExchangeFeeRateForTribes(
					[sAUD, hUSD, sEUR],
					[toUnit(0), toUnit(0), toUnit(0)],
					{
						from: owner,
					}
				);
				// Disable Dynamic fee so that we can neglect it.
				await systemSettings.setExchangeDynamicFeeRounds('0', { from: owner });

				await sEURContract.issue(account1, toUnit(20));
				await debtCache.takeDebtSnapshot();
				const issued = (await debtCache.cacheInfo())[0];

				const debts = await debtCache.cachedTribeDebts([sAUD, sEUR]);

				await updateAggregatorRates(
					exchangeRates,
					circuitBreaker,
					[sAUD, sEUR],
					['1', '1'].map(toUnit)
				);

				await tribeone.exchange(sEUR, toUnit(10), sAUD, { from: account1 });
				const postDebts = await debtCache.cachedTribeDebts([sAUD, sEUR]);

				// 120 eur @ $2 = $240 and 100 aud @ $0.50 = $50 becomes:
				// 110 eur @ $1 = $110 (-$130) and 110 aud @ $1 = $110 (+$60)
				// Total debt is reduced by $130 - $60 = $70
				assert.bnEqual((await debtCache.cacheInfo())[0], issued.sub(toUnit(70)));
				assert.bnEqual(postDebts[0], debts[0].add(toUnit(60)));
				assert.bnEqual(postDebts[1], debts[1].sub(toUnit(130)));
			});

			it('settlement updates debt totals', async () => {
				// Zero exchange fees so that we can neglect them.
				await systemSettings.setExchangeFeeRateForTribes([sAUD, sEUR], [toUnit(0), toUnit(0)], {
					from: owner,
				});
				// Disable Dynamic fee so that we can neglect it.
				await systemSettings.setExchangeDynamicFeeRounds('0', { from: owner });

				await sAUDContract.issue(account1, toUnit(100));

				await debtCache.takeDebtSnapshot();

				const cachedDebt = await debtCache.cachedDebt();

				await tribeone.exchange(sAUD, toUnit(50), sEUR, { from: account1 });
				// so there's now 100 - 25 hUSD left (25 of it was exchanged)
				// and now there's 100 + (25 / 2 ) of sEUR = 112.5

				await systemSettings.setWaitingPeriodSecs(60, { from: owner });
				// set a high price deviation threshold factor to be sure it doesn't trigger here
				await systemSettings.setPriceDeviationThresholdFactor(toUnit('99'), { from: owner });

				await updateAggregatorRates(
					exchangeRates,
					circuitBreaker,
					[sAUD, sEUR],
					['2', '1'].map(toUnit)
				);

				await fastForward(100);

				const tx = await exchanger.settle(account1, sEUR);
				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				// The A$75 does not change as we settled sEUR
				// But the EUR changes from 112.5 + 87.5 rebate = 200
				const results = await debtCache.cachedTribeDebts([sAUD, sEUR]);
				assert.bnEqual(results[0], toUnit(75));
				assert.bnEqual(results[1], toUnit(200));

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [cachedDebt.sub(toUnit('25'))], // deduct the 25 units of sAUD
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});
		});

		describe('Tribe removal and addition', () => {
			it('Removing tribes zeroes out the debt snapshot for that currency', async () => {
				await debtCache.takeDebtSnapshot();
				const issued = (await debtCache.cacheInfo())[0];
				const sEURValue = (await debtCache.cachedTribeDebts([sEUR]))[0];
				await sEURContract.setTotalSupply(toUnit(0));
				const tx = await issuer.removeTribe(sEUR, { from: owner });
				const result = (await debtCache.cachedTribeDebts([sEUR]))[0];
				const newIssued = (await debtCache.cacheInfo())[0];
				assert.bnEqual(newIssued, issued.sub(sEURValue));
				assert.bnEqual(result, toUnit(0));

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [newIssued],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});

			it('Tribe snapshots cannot be purged while the tribe exists', async () => {
				await assert.revert(debtCache.purgeCachedTribeDebt(sAUD, { from: owner }), 'Tribe exists');
			});

			it('Tribe snapshots can be purged without updating the snapshot', async () => {
				const debtCacheName = toBytes32('DebtCache');
				const newDebtCache = await setupContract({
					contract: 'TestableDebtCache',
					accounts,
					skipPostDeploy: true,
					args: [owner, addressResolver.address],
				});
				await addressResolver.importAddresses([debtCacheName], [newDebtCache.address], {
					from: owner,
				});
				await newDebtCache.rebuildCache();
				await newDebtCache.takeDebtSnapshot();
				const issued = (await newDebtCache.cacheInfo())[0];

				const fakeTokenKey = toBytes32('FAKE');

				// Set a cached snapshot value
				await newDebtCache.setCachedTribeDebt(fakeTokenKey, toUnit('1'));

				// Purging deletes the value
				assert.bnEqual(await newDebtCache.cachedTribeDebt(fakeTokenKey), toUnit(1));
				await newDebtCache.purgeCachedTribeDebt(fakeTokenKey, { from: owner });
				assert.bnEqual(await newDebtCache.cachedTribeDebt(fakeTokenKey), toUnit(0));

				// Without affecting the snapshot.
				assert.bnEqual((await newDebtCache.cacheInfo())[0], issued);
			});

			it('Removing a tribe invalidates the debt cache', async () => {
				await sEURContract.setTotalSupply(toUnit('0'));
				assert.isFalse((await debtCache.cacheInfo())[2]);
				const tx = await issuer.removeTribe(sEUR, { from: owner });
				assert.isTrue((await debtCache.cacheInfo())[2]);

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheValidityChanged',
					emittedFrom: debtCache.address,
					args: [true],
					log: logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'),
				});
			});

			it('Adding a tribe invalidates the debt cache', async () => {
				const { token: tribe } = await mockToken({
					accounts,
					tribe: 'sXYZ',
					skipInitialAllocation: true,
					supply: 0,
					name: 'XYZ',
					symbol: 'XYZ',
				});

				assert.isFalse((await debtCache.cacheInfo())[2]);
				const tx = await issuer.addTribe(tribe.address, { from: owner });
				assert.isTrue((await debtCache.cacheInfo())[2]);

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheValidityChanged',
					emittedFrom: debtCache.address,
					args: [true],
					log: logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'),
				});
			});

			it('Adding multiple tribes invalidates the debt cache', async () => {
				const { token: tribe1 } = await mockToken({
					accounts,
					tribe: 'sXYZ',
					skipInitialAllocation: true,
					supply: 0,
					name: 'XYZ',
					symbol: 'XYZ',
				});
				const { token: tribe2 } = await mockToken({
					accounts,
					tribe: 'sABC',
					skipInitialAllocation: true,
					supply: 0,
					name: 'ABC',
					symbol: 'ABC',
				});

				assert.isFalse((await debtCache.cacheInfo())[2]);
				const tx = await issuer.addTribes([tribe1.address, tribe2.address], { from: owner });
				assert.isTrue((await debtCache.cacheInfo())[2]);

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheValidityChanged',
					emittedFrom: debtCache.address,
					args: [true],
					log: logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'),
				});
			});

			it('Removing multiple tribes invalidates the debt cache', async () => {
				await sAUDContract.setTotalSupply(toUnit('0'));
				await sEURContract.setTotalSupply(toUnit('0'));

				assert.isFalse((await debtCache.cacheInfo())[2]);
				const tx = await issuer.removeTribes([sEUR, sAUD], { from: owner });
				assert.isTrue((await debtCache.cacheInfo())[2]);

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheValidityChanged',
					emittedFrom: debtCache.address,
					args: [true],
					log: logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'),
				});
			});

			it('Removing multiple tribes zeroes the debt cache for those currencies', async () => {
				await debtCache.takeDebtSnapshot();
				const issued = (await debtCache.cacheInfo())[0];
				const sEURValue = (await debtCache.cachedTribeDebts([sEUR]))[0];
				const sAUDValue = (await debtCache.cachedTribeDebts([sAUD]))[0];
				await sEURContract.setTotalSupply(toUnit(0));
				await sAUDContract.setTotalSupply(toUnit(0));
				const tx = await issuer.removeTribes([sEUR, sAUD], { from: owner });
				const result = await debtCache.cachedTribeDebts([sEUR, sAUD]);
				const newIssued = (await debtCache.cacheInfo())[0];
				assert.bnEqual(newIssued, issued.sub(sEURValue.add(sAUDValue)));
				assert.bnEqual(result[0], toUnit(0));
				assert.bnEqual(result[1], toUnit(0));

				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [newIssued],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});
		});

		describe('updateDebtCacheValidity()', () => {
			beforeEach(async () => {
				// Ensure the cache is valid.
				await debtCache.takeDebtSnapshot();

				// Change the calling address in the addressResolver so that the calls don't fail.
				const issuerName = toBytes32('Issuer');
				await addressResolver.importAddresses([issuerName], [account1], {
					from: owner,
				});
				await debtCache.rebuildCache();
			});

			describe('when the debt cache is valid', () => {
				it('invalidates the cache', async () => {
					assert.isFalse((await debtCache.cacheInfo()).isInvalid);
					const tx = await debtCache.updateDebtCacheValidity(true, { from: account1 });
					assert.isTrue((await debtCache.cacheInfo()).isInvalid);

					const logs = await getDecodedLogs({
						hash: tx.tx,
						contracts: [debtCache],
					});

					decodedEventEqual({
						event: 'DebtCacheValidityChanged',
						emittedFrom: debtCache.address,
						args: [true],
						log: logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'),
					});
				});

				it('does nothing if attempting to re-validate the cache', async () => {
					assert.isFalse((await debtCache.cacheInfo()).isInvalid);
					const tx = await debtCache.updateDebtCacheValidity(false, { from: account1 });
					assert.isFalse((await debtCache.cacheInfo()).isInvalid);

					const logs = await getDecodedLogs({
						hash: tx.tx,
						contracts: [debtCache],
					});

					assert.isUndefined(logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'));
				});
			});

			describe('when the debt cache is invalid', () => {
				beforeEach(async () => {
					// Invalidate the cache first.
					await debtCache.updateDebtCacheValidity(true, { from: account1 });
				});

				it('re-validates the cache', async () => {
					assert.isTrue((await debtCache.cacheInfo()).isInvalid);
					const tx = await debtCache.updateDebtCacheValidity(false, { from: account1 });
					assert.isFalse((await debtCache.cacheInfo()).isInvalid);

					const logs = await getDecodedLogs({
						hash: tx.tx,
						contracts: [debtCache],
					});

					decodedEventEqual({
						event: 'DebtCacheValidityChanged',
						emittedFrom: debtCache.address,
						args: [false],
						log: logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'),
					});
				});

				it('does nothing if attempting to invalidate the cache', async () => {
					assert.isTrue((await debtCache.cacheInfo()).isInvalid);
					const tx = await debtCache.updateDebtCacheValidity(true, { from: account1 });
					assert.isTrue((await debtCache.cacheInfo()).isInvalid);

					const logs = await getDecodedLogs({
						hash: tx.tx,
						contracts: [debtCache],
					});

					assert.isUndefined(logs.find(({ name } = {}) => name === 'DebtCacheValidityChanged'));
				});
			});
		});
	});

	describe('totalNonSnxBackedDebt', async () => {
		let totalNonSnxBackedDebt;
		let currentDebt;

		const getTotalNonSnxBackedDebt = async () => {
			const { excludedDebt } = await debtCache.totalNonSnxBackedDebt();
			return excludedDebt;
		};

		beforeEach(async () => {
			// Issue some debt to avoid a division-by-zero in `getBorrowRate` where
			// we compute the utilisation.
			await tribeone.transfer(account1, toUnit('1000'), { from: owner });
			await tribeone.issueTribes(toUnit('10'), { from: account1 });

			totalNonSnxBackedDebt = await getTotalNonSnxBackedDebt();
			currentDebt = await debtCache.currentDebt();
		});

		describe('when MultiCollateral loans are opened', async () => {
			let rate;

			beforeEach(async () => {
				await setupMultiCollateral();

				({ rate } = await exchangeRates.rateAndInvalid(hETH));

				await ceth.open(oneETH, hETH, {
					value: twoETH,
					from: account1,
				});
			});

			it('increases non-wHAKA debt', async () => {
				assert.bnEqual(
					totalNonSnxBackedDebt.add(multiplyDecimalRound(oneETH, rate)),
					await getTotalNonSnxBackedDebt()
				);
			});
			it('is excluded from currentDebt', async () => {
				assert.bnEqual(currentDebt, await debtCache.currentDebt());
			});

			describe('after the tribes are exchanged into other tribes', async () => {
				let tx;
				beforeEach(async () => {
					// Swap some hETH into tribeetic dollarydoos.
					tx = await tribeone.exchange(hETH, '5', sAUD, { from: account1 });
				});

				it('non-wHAKA debt is unchanged', async () => {
					assert.bnEqual(
						totalNonSnxBackedDebt.add(multiplyDecimalRound(oneETH, rate)),
						await getTotalNonSnxBackedDebt()
					);
				});
				it('currentDebt is unchanged', async () => {
					assert.bnEqual(currentDebt, await debtCache.currentDebt());
				});

				it('cached debt is properly updated', async () => {
					const logs = await getDecodedLogs({
						hash: tx.tx,
						contracts: [debtCache],
					});

					const cachedDebt = (await debtCache.cacheInfo())[0];
					decodedEventEqual({
						event: 'DebtCacheUpdated',
						emittedFrom: debtCache.address,
						args: [cachedDebt],
						log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
					});
				});
			});

			it('is properly reflected in a snapshot', async () => {
				const currentDebt = (await debtCache.currentDebt())[0];
				const cachedDebt = (await debtCache.cacheInfo())[0];
				assert.bnEqual(currentDebt, cachedDebt);
				const tx = await debtCache.takeDebtSnapshot();
				const logs = await getDecodedLogs({
					hash: tx.tx,
					contracts: [debtCache],
				});

				decodedEventEqual({
					event: 'DebtCacheUpdated',
					emittedFrom: debtCache.address,
					args: [cachedDebt],
					log: logs.find(({ name } = {}) => name === 'DebtCacheUpdated'),
				});
			});
		});

		describe('when shorts are opened', async () => {
			let rate;
			let amount;

			beforeEach(async () => {
				({ rate } = await exchangeRates.rateAndInvalid(hETH));

				// Take out a short position on hETH.
				// hUSD collateral = 1.5 * rate_eth
				amount = multiplyDecimalRound(rate, toUnit('1.5'));
				await hUSDContract.issue(account1, amount, { from: owner });
				// Again, avoid a divide-by-zero in computing the short rate,
				// by ensuring hETH.totalSupply() > 0.
				await hETHContract.issue(account1, amount, { from: owner });

				await setupShort();
				await short.setIssueFeeRate(toUnit('0'), { from: owner });
				await short.open(amount, oneETH, hETH, { from: account1 });
			});

			it('increases non-wHAKA debt', async () => {
				assert.bnEqual(totalNonSnxBackedDebt.add(rate), await getTotalNonSnxBackedDebt());
			});
			it('is excluded from currentDebt', async () => {
				assert.bnEqual(currentDebt, await debtCache.currentDebt());
			});
		});
	});
});
