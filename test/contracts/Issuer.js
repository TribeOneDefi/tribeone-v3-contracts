'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { setupAllContracts, mockToken } = require('./setup');

const MockEtherWrapper = artifacts.require('MockEtherWrapper');
const MockAggregator = artifacts.require('MockAggregatorV2V3');

const {
	currentTime,
	multiplyDecimal,
	divideDecimalRound,
	divideDecimal,
	toUnit,
	toPreciseUnit,
	fastForward,
} = require('../utils')();

const {
	setExchangeWaitingPeriod,
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
	constants: { ZERO_ADDRESS },
	defaults: { ISSUANCE_RATIO, MINIMUM_STAKE_TIME },
} = require('../..');

contract('Issuer (via Tribeone)', async accounts => {
	const WEEK = 604800;

	const [hUSD, sAUD, sEUR, wHAKA, hETH, ETH] = ['hUSD', 'sAUD', 'sEUR', 'wHAKA', 'hETH', 'ETH'].map(
		toBytes32
	);
	const tribeKeys = [hUSD, sAUD, sEUR, hETH, wHAKA];

	const [, owner, account1, account2, account3, account6, tribeetixBridgeToOptimism] = accounts;

	let tribeone,
		tribeetixProxy,
		systemStatus,
		systemSettings,
		delegateApprovals,
		exchangeRates,
		feePool,
		hUSDContract,
		hETHContract,
		sEURContract,
		sAUDContract,
		escrow,
		rewardEscrowV2,
		debtCache,
		issuer,
		tribes,
		addressResolver,
		tribeRedeemer,
		exchanger,
		aggregatorDebtRatio,
		aggregatorIssuedTribes,
		circuitBreaker,
		debtShares;

	// run this once before all tests to prepare our environment, snapshots on beforeEach will take
	// care of resetting to this state
	before(async () => {
		tribes = ['hUSD', 'sAUD', 'sEUR', 'hETH'];
		({
			Tribeone: tribeone,
			ProxyERC20Tribeone: tribeetixProxy,
			SystemStatus: systemStatus,
			SystemSettings: systemSettings,
			ExchangeRates: exchangeRates,
			TribeoneEscrow: escrow,
			RewardEscrowV2: rewardEscrowV2,
			TribehUSD: hUSDContract,
			TribehETH: hETHContract,
			TribesAUD: sAUDContract,
			TribesEUR: sEURContract,
			Exchanger: exchanger,
			FeePool: feePool,
			DebtCache: debtCache,
			Issuer: issuer,
			DelegateApprovals: delegateApprovals,
			AddressResolver: addressResolver,
			TribeRedeemer: tribeRedeemer,
			TribeoneDebtShare: debtShares,
			CircuitBreaker: circuitBreaker,
			'ext:AggregatorDebtRatio': aggregatorDebtRatio,
			'ext:AggregatorIssuedTribes': aggregatorIssuedTribes,
		} = await setupAllContracts({
			accounts,
			tribes,
			contracts: [
				'Tribeone',
				'ExchangeRates',
				'FeePool',
				'FeePoolEternalStorage',
				'AddressResolver',
				'RewardEscrowV2',
				'TribeoneEscrow',
				'SystemSettings',
				'Issuer',
				'LiquidatorRewards',
				'OneNetAggregatorIssuedTribes',
				'OneNetAggregatorDebtRatio',
				'DebtCache',
				'Exchanger', // necessary for burnTribes to check settlement of hUSD
				'DelegateApprovals', // necessary for *OnBehalf functions
				'FlexibleStorage',
				'CollateralManager',
				'TribeRedeemer',
				'TribeoneDebtShare',
			],
		}));

		// use implementation ABI on the proxy address to simplify calling
		tribeone = await artifacts.require('Tribeone').at(tribeetixProxy.address);

		// mocks for bridge
		await addressResolver.importAddresses(
			['TribeoneBridgeToOptimism'].map(toBytes32),
			[tribeetixBridgeToOptimism],
			{ from: owner }
		);

		await setupPriceAggregators(exchangeRates, owner, [sAUD, sEUR, hETH, ETH]);
	});

	async function updateDebtMonitors() {
		await debtCache.takeDebtSnapshot();
		await circuitBreaker.resetLastValue(
			[aggregatorIssuedTribes.address, aggregatorDebtRatio.address],
			[
				(await aggregatorIssuedTribes.latestRoundData())[1],
				(await aggregatorDebtRatio.latestRoundData())[1],
			],
			{ from: owner }
		);
	}

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateAggregatorRates(
			exchangeRates,
			circuitBreaker,
			[sAUD, sEUR, wHAKA, hETH],
			['0.5', '1.25', '0.1', '200'].map(toUnit)
		);

		// set a 0.3% default exchange fee rate
		const exchangeFeeRate = toUnit('0.003');
		await setExchangeFeeRateForTribes({
			owner,
			systemSettings,
			tribeKeys,
			exchangeFeeRates: tribeKeys.map(() => exchangeFeeRate),
		});
		await updateDebtMonitors();
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: issuer.abi,
			ignoreParents: ['Owned', 'MixinResolver'],
			expected: [
				'addTribe',
				'addTribes',
				'burnForRedemption',
				'burnTribes',
				'burnTribesOnBehalf',
				'burnTribesToTarget',
				'burnTribesToTargetOnBehalf',
				'issueTribesWithoutDebt',
				'burnTribesWithoutDebt',
				'issueMaxTribes',
				'issueMaxTribesOnBehalf',
				'issueTribes',
				'issueTribesOnBehalf',
				'liquidateAccount',
				'modifyDebtSharesForMigration',
				'removeTribe',
				'removeTribes',
				'setCurrentPeriodId',
				'upgradeCollateralShort',
			],
		});
	});

	it('minimum stake time is correctly configured as a default', async () => {
		assert.bnEqual(await issuer.minimumStakeTime(), MINIMUM_STAKE_TIME);
	});

	it('issuance ratio is correctly configured as a default', async () => {
		assert.bnEqual(await issuer.issuanceRatio(), ISSUANCE_RATIO);
	});

	describe('protected methods', () => {
		it('issueTribesWithoutDebt() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueTribesWithoutDebt,
				args: [hUSD, owner, toUnit(100)],
				accounts,
				address: tribeetixBridgeToOptimism,
				reason: 'only trusted minters',
			});
		});

		it('burnTribesWithoutDebt() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnTribesWithoutDebt,
				args: [hUSD, owner, toUnit(100)],
				// full functionality of this method requires issuing tribes,
				// so just test that its blocked here and don't include the trusted addr
				accounts: [owner, account1],
				reason: 'only trusted minters',
			});
		});

		it('modifyDebtSharesForMigration() cannont be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.modifyDebtSharesForMigration,
				args: [account1, toUnit(100)],
				accounts,
				reason: 'only trusted migrators',
			});
		});

		it('issueTribes() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueTribes,
				args: [account1, toUnit('1')],
				accounts,
				reason: 'Only Tribeone',
			});
		});
		it('issueTribesOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueTribesOnBehalf,
				args: [account1, account2, toUnit('1')],
				accounts,
				reason: 'Only Tribeone',
			});
		});
		it('issueMaxTribes() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueMaxTribes,
				args: [account1],
				accounts,
				reason: 'Only Tribeone',
			});
		});
		it('issueMaxTribesOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.issueMaxTribesOnBehalf,
				args: [account1, account2],
				accounts,
				reason: 'Only Tribeone',
			});
		});
		it('burnTribes() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnTribes,
				args: [account1, toUnit('1')],
				accounts,
				reason: 'Only Tribeone',
			});
		});
		it('burnTribesOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnTribesOnBehalf,
				args: [account1, account2, toUnit('1')],
				accounts,
				reason: 'Only Tribeone',
			});
		});
		it('burnTribesToTarget() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnTribesToTarget,
				args: [account1],
				accounts,
				reason: 'Only Tribeone',
			});
		});
		it('liquidateAccount() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.liquidateAccount,
				args: [account1, false],
				accounts,
				reason: 'Only Tribeone',
			});
		});
		it('burnTribesToTargetOnBehalf() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.burnTribesToTargetOnBehalf,
				args: [account1, account2],
				accounts,
				reason: 'Only Tribeone',
			});
		});
		it('setCurrentPeriodId() cannot be invoked directly by a user', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: issuer.setCurrentPeriodId,
				args: [1234],
				accounts,
				reason: 'Must be fee pool',
			});
		});
	});

	describe('when minimum stake time is set to 0', () => {
		beforeEach(async () => {
			// set minimumStakeTime on issue and burning to 0
			await systemSettings.setMinimumStakeTime(0, { from: owner });
		});
		describe('when the issuanceRatio is 0.2', () => {
			beforeEach(async () => {
				// set default issuance ratio of 0.2
				await systemSettings.setIssuanceRatio(toUnit('0.2'), { from: owner });
			});

			describe('minimumStakeTime - recording last issue and burn timestamp', async () => {
				let now;

				beforeEach(async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('1000'), { from: owner });

					now = await currentTime();
				});

				it('should issue tribes and store issue timestamp after now', async () => {
					// issue tribes
					await tribeone.issueTribes(web3.utils.toBN('5'), { from: account1 });

					// issue timestamp should be greater than now in future
					const issueTimestamp = await issuer.lastIssueEvent(owner);
					assert.ok(issueTimestamp.gte(now));
				});

				describe('require wait time on next burn tribe after minting', async () => {
					it('should revert when burning any tribes within minStakeTime', async () => {
						// set minimumStakeTime
						await systemSettings.setMinimumStakeTime(60 * 60 * 8, { from: owner });

						// issue tribes first
						await tribeone.issueTribes(web3.utils.toBN('5'), { from: account1 });

						await assert.revert(
							tribeone.burnTribes(web3.utils.toBN('5'), { from: account1 }),
							'Minimum stake time not reached'
						);
					});
					it('should set minStakeTime to 120 seconds and able to burn after wait time', async () => {
						// set minimumStakeTime
						await systemSettings.setMinimumStakeTime(120, { from: owner });

						// issue tribes first
						await tribeone.issueTribes(toUnit('0.001'), { from: account1 });

						// fastForward 30 seconds
						await fastForward(10);

						await assert.revert(
							tribeone.burnTribes(toUnit('0.001'), { from: account1 }),
							'Minimum stake time not reached'
						);

						// fastForward 115 seconds
						await fastForward(125);

						// burn tribes
						await tribeone.burnTribes(toUnit('0.001'), { from: account1 });
					});
				});
			});

			describe('allNetworksDebtInfo()', () => {
				describe('when exchange rates set', () => {
					beforeEach(async () => {
						await fastForward(10);
						// Send a price update to give the tribe rates

						await updateAggregatorRates(
							exchangeRates,
							circuitBreaker,
							[sAUD, sEUR, hETH, ETH, wHAKA],
							['0.5', '1.25', '100', '100', '2'].map(toUnit)
						);
					});

					describe('when numerous issues in many currencies', () => {
						beforeEach(async () => {
							// as our tribes are mocks, let's issue some amount to users
							await hUSDContract.issue(account1, toUnit('1000'));

							await sAUDContract.issue(account1, toUnit('1000')); // 500 hUSD worth
							await sAUDContract.issue(account2, toUnit('1000')); // 500 hUSD worth

							await sEURContract.issue(account3, toUnit('80')); // 100 hUSD worth

							await hETHContract.issue(account1, toUnit('1')); // 100 hUSD worth

							// and since we are are bypassing the usual issuance flow here, we must cache the debt snapshot
							assert.bnEqual(await tribeone.totalIssuedTribes(hUSD), toUnit('0'));
							await updateDebtMonitors();
						});
						it('then should have recorded debt and debt shares even though there are none', async () => {
							const debtInfo = await issuer.allNetworksDebtInfo();

							assert.bnEqual(debtInfo.debt, toUnit('2200'));
							assert.bnEqual(debtInfo.sharesSupply, toUnit('2200')); // stays 0 if no debt shares are minted
							assert.isFalse(debtInfo.isStale);
						});
					});

					describe('when issued through wHAKA staking', () => {
						beforeEach(async () => {
							// as our tribes are mocks, let's issue some amount to users
							const issuedTribeones = web3.utils.toBN('200012');
							await tribeone.transfer(account1, toUnit(issuedTribeones), {
								from: owner,
							});

							// Issue
							const amountIssued = toUnit('2011');
							await tribeone.issueTribes(amountIssued, { from: account1 });
							await updateDebtMonitors();
						});
						it('then should have recorded debt and debt shares', async () => {
							const debtInfo = await issuer.allNetworksDebtInfo();

							assert.bnEqual(debtInfo.debt, toUnit('2011'));
							assert.bnEqual(debtInfo.sharesSupply, toUnit('2011'));
							assert.isFalse(debtInfo.isStale);
						});
					});

					describe('when oracle updatedAt is old', () => {
						beforeEach(async () => {
							// as our tribes are mocks, let's issue some amount to users
							const issuedTribeones = web3.utils.toBN('200012');
							await tribeone.transfer(account1, toUnit(issuedTribeones), {
								from: owner,
							});

							// Issue
							const amountIssued = toUnit('2011');
							await tribeone.issueTribes(amountIssued, { from: account1 });
							await updateDebtMonitors();

							await aggregatorDebtRatio.setOverrideTimestamp(500); // really old timestamp
						});
						it('then isStale = true', async () => {
							assert.isTrue((await issuer.allNetworksDebtInfo()).isStale);
						});
					});
				});
			});

			describe('totalIssuedTribes()', () => {
				describe('when exchange rates set', () => {
					beforeEach(async () => {
						await fastForward(10);
						// Send a price update to give the tribe rates
						await updateAggregatorRates(
							exchangeRates,
							circuitBreaker,
							[sAUD, sEUR, hETH, ETH, wHAKA],
							['0.5', '1.25', '100', '100', '2'].map(toUnit)
						);
						await updateDebtMonitors();
					});

					describe('when numerous issues in one currency', () => {
						beforeEach(async () => {
							// as our tribes are mocks, let's issue some amount to users
							await hUSDContract.issue(account1, toUnit('1000'));
							await hUSDContract.issue(account2, toUnit('100'));
							await hUSDContract.issue(account3, toUnit('10'));
							await hUSDContract.issue(account1, toUnit('1'));

							// and since we are are bypassing the usual issuance flow here, we must cache the debt snapshot
							assert.bnEqual(await tribeone.totalIssuedTribes(hUSD), toUnit('0'));
							await updateDebtMonitors();
						});
						it('then totalIssuedTribes in should correctly calculate the total issued tribes in hUSD', async () => {
							assert.bnEqual(await tribeone.totalIssuedTribes(hUSD), toUnit('1111'));
						});
						it('and in another tribe currency', async () => {
							assert.bnEqual(await tribeone.totalIssuedTribes(sAUD), toUnit('2222'));
						});
						it('and in wHAKA', async () => {
							assert.bnEqual(await tribeone.totalIssuedTribes(wHAKA), divideDecimal('1111', '2'));
						});
						it('and in a non-tribe currency', async () => {
							assert.bnEqual(await tribeone.totalIssuedTribes(ETH), divideDecimal('1111', '100'));
						});
						it('and in an unknown currency, reverts', async () => {
							await assert.revert(
								tribeone.totalIssuedTribes(toBytes32('XYZ')),
								'SafeMath: division by zero'
							);
						});
					});

					describe('when numerous issues in many currencies', () => {
						beforeEach(async () => {
							// as our tribes are mocks, let's issue some amount to users
							await hUSDContract.issue(account1, toUnit('1000'));

							await sAUDContract.issue(account1, toUnit('1000')); // 500 hUSD worth
							await sAUDContract.issue(account2, toUnit('1000')); // 500 hUSD worth

							await sEURContract.issue(account3, toUnit('80')); // 100 hUSD worth

							await hETHContract.issue(account1, toUnit('1')); // 100 hUSD worth

							// and since we are are bypassing the usual issuance flow here, we must cache the debt snapshot
							assert.bnEqual(await tribeone.totalIssuedTribes(hUSD), toUnit('0'));
							await updateDebtMonitors();
						});
						it('then totalIssuedTribes in should correctly calculate the total issued tribes in hUSD', async () => {
							assert.bnEqual(await tribeone.totalIssuedTribes(hUSD), toUnit('2200'));
						});
						it('and in another tribe currency', async () => {
							assert.bnEqual(await tribeone.totalIssuedTribes(sAUD), toUnit('4400', '2'));
						});
						it('and in wHAKA', async () => {
							assert.bnEqual(await tribeone.totalIssuedTribes(wHAKA), divideDecimal('2200', '2'));
						});
						it('and in a non-tribe currency', async () => {
							assert.bnEqual(await tribeone.totalIssuedTribes(ETH), divideDecimal('2200', '100'));
						});
						it('and in an unknown currency, reverts', async () => {
							await assert.revert(
								tribeone.totalIssuedTribes(toBytes32('XYZ')),
								'SafeMath: division by zero'
							);
						});
					});
				});
			});

			describe('debtBalance()', () => {
				it('should not change debt balance % if exchange rates change', async () => {
					let newAUDRate = toUnit('0.5');
					await updateAggregatorRates(exchangeRates, circuitBreaker, [sAUD], [newAUDRate]);
					await updateDebtMonitors();

					await tribeone.transfer(account1, toUnit('20000'), {
						from: owner,
					});
					await tribeone.transfer(account2, toUnit('20000'), {
						from: owner,
					});

					const amountIssuedAcc1 = toUnit('30');
					const amountIssuedAcc2 = toUnit('50');
					await tribeone.issueTribes(amountIssuedAcc1, { from: account1 });
					await tribeone.issueTribes(amountIssuedAcc2, { from: account2 });

					await tribeone.exchange(hUSD, amountIssuedAcc2, sAUD, { from: account2 });

					const PRECISE_UNIT = web3.utils.toWei(web3.utils.toBN('1'), 'gether');
					let totalIssuedTribehUSD = await tribeone.totalIssuedTribes(hUSD);
					const account1DebtRatio = divideDecimal(
						amountIssuedAcc1,
						totalIssuedTribehUSD,
						PRECISE_UNIT
					);
					const account2DebtRatio = divideDecimal(
						amountIssuedAcc2,
						totalIssuedTribehUSD,
						PRECISE_UNIT
					);

					newAUDRate = toUnit('1.85');
					await updateAggregatorRates(exchangeRates, circuitBreaker, [sAUD], [newAUDRate]);
					await updateDebtMonitors();

					totalIssuedTribehUSD = await tribeone.totalIssuedTribes(hUSD);
					const conversionFactor = web3.utils.toBN(1000000000);
					const expectedDebtAccount1 = multiplyDecimal(
						account1DebtRatio,
						totalIssuedTribehUSD.mul(conversionFactor),
						PRECISE_UNIT
					).div(conversionFactor);
					const expectedDebtAccount2 = multiplyDecimal(
						account2DebtRatio,
						totalIssuedTribehUSD.mul(conversionFactor),
						PRECISE_UNIT
					).div(conversionFactor);

					assert.bnClose(await tribeone.debtBalanceOf(account1, hUSD), expectedDebtAccount1);
					assert.bnClose(await tribeone.debtBalanceOf(account2, hUSD), expectedDebtAccount2);
				});

				it("should correctly calculate a user's debt balance without prior issuance", async () => {
					await tribeone.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await tribeone.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					const debt1 = await tribeone.debtBalanceOf(account1, toBytes32('hUSD'));
					const debt2 = await tribeone.debtBalanceOf(account2, toBytes32('hUSD'));
					assert.bnEqual(debt1, 0);
					assert.bnEqual(debt2, 0);
				});

				it("should correctly calculate a user's debt balance with prior issuance", async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('200000'), {
						from: owner,
					});

					// Issue
					const issuedTribes = toUnit('1001');
					await tribeone.issueTribes(issuedTribes, { from: account1 });

					const debt = await tribeone.debtBalanceOf(account1, toBytes32('hUSD'));
					assert.bnEqual(debt, issuedTribes);
				});
			});

			describe('remainingIssuableTribes()', () => {
				it("should correctly calculate a user's remaining issuable tribes with prior issuance", async () => {
					const snx2usdRate = await exchangeRates.rateForCurrency(wHAKA);
					const issuanceRatio = await systemSettings.issuanceRatio();

					const issuedTribeones = web3.utils.toBN('200012');
					await tribeone.transfer(account1, toUnit(issuedTribeones), {
						from: owner,
					});

					// Issue
					const amountIssued = toUnit('2011');
					await tribeone.issueTribes(amountIssued, { from: account1 });

					const expectedIssuableTribes = multiplyDecimal(
						toUnit(issuedTribeones),
						multiplyDecimal(snx2usdRate, issuanceRatio)
					).sub(amountIssued);

					const issuableTribes = await issuer.remainingIssuableTribes(account1);
					assert.bnEqual(issuableTribes.maxIssuable, expectedIssuableTribes);

					// other args should also be correct
					assert.bnEqual(issuableTribes.totalSystemDebt, amountIssued);
					assert.bnEqual(issuableTribes.alreadyIssued, amountIssued);
				});

				it("should correctly calculate a user's remaining issuable tribes without prior issuance", async () => {
					const snx2usdRate = await exchangeRates.rateForCurrency(wHAKA);
					const issuanceRatio = await systemSettings.issuanceRatio();

					const issuedTribeones = web3.utils.toBN('20');
					await tribeone.transfer(account1, toUnit(issuedTribeones), {
						from: owner,
					});

					const expectedIssuableTribes = multiplyDecimal(
						toUnit(issuedTribeones),
						multiplyDecimal(snx2usdRate, issuanceRatio)
					);

					const remainingIssuable = await issuer.remainingIssuableTribes(account1);
					assert.bnEqual(remainingIssuable.maxIssuable, expectedIssuableTribes);
				});
			});

			describe('maxIssuableTribes()', () => {
				it("should correctly calculate a user's maximum issuable tribes without prior issuance", async () => {
					const rate = await exchangeRates.rateForCurrency(toBytes32('wHAKA'));
					const issuedTribeones = web3.utils.toBN('200000');
					await tribeone.transfer(account1, toUnit(issuedTribeones), {
						from: owner,
					});
					const issuanceRatio = await systemSettings.issuanceRatio();

					const expectedIssuableTribes = multiplyDecimal(
						toUnit(issuedTribeones),
						multiplyDecimal(rate, issuanceRatio)
					);
					const maxIssuableTribes = await tribeone.maxIssuableTribes(account1);

					assert.bnEqual(expectedIssuableTribes, maxIssuableTribes);
				});

				it("should correctly calculate a user's maximum issuable tribes without any wHAKA", async () => {
					const maxIssuableTribes = await tribeone.maxIssuableTribes(account1);
					assert.bnEqual(0, maxIssuableTribes);
				});

				it("should correctly calculate a user's maximum issuable tribes with prior issuance", async () => {
					const snx2usdRate = await exchangeRates.rateForCurrency(wHAKA);

					const issuedTribeones = web3.utils.toBN('320001');
					await tribeone.transfer(account1, toUnit(issuedTribeones), {
						from: owner,
					});

					const issuanceRatio = await systemSettings.issuanceRatio();
					const amountIssued = web3.utils.toBN('1234');
					await tribeone.issueTribes(toUnit(amountIssued), { from: account1 });

					const expectedIssuableTribes = multiplyDecimal(
						toUnit(issuedTribeones),
						multiplyDecimal(snx2usdRate, issuanceRatio)
					);

					const maxIssuableTribes = await tribeone.maxIssuableTribes(account1);
					assert.bnEqual(expectedIssuableTribes, maxIssuableTribes);
				});
			});

			describe('adding and removing tribes', () => {
				it('should allow adding a Tribe contract', async () => {
					const previousTribeCount = await tribeone.availableTribeCount();

					const { token: tribe } = await mockToken({
						accounts,
						tribe: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					const txn = await issuer.addTribe(tribe.address, { from: owner });

					const currencyKey = toBytes32('sXYZ');

					// Assert that we've successfully added a Tribe
					assert.bnEqual(
						await tribeone.availableTribeCount(),
						previousTribeCount.add(web3.utils.toBN(1))
					);
					// Assert that it's at the end of the array
					assert.equal(await tribeone.availableTribes(previousTribeCount), tribe.address);
					// Assert that it's retrievable by its currencyKey
					assert.equal(await tribeone.tribes(currencyKey), tribe.address);

					// Assert event emitted
					assert.eventEqual(txn.logs[0], 'TribeAdded', [currencyKey, tribe.address]);
				});

				it('should disallow adding a Tribe contract when the user is not the owner', async () => {
					const { token: tribe } = await mockToken({
						accounts,
						tribe: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					await onlyGivenAddressCanInvoke({
						fnc: issuer.addTribe,
						accounts,
						args: [tribe.address],
						address: owner,
						reason: 'Only the contract owner may perform this action',
					});
				});

				it('should disallow double adding a Tribe contract with the same address', async () => {
					const { token: tribe } = await mockToken({
						accounts,
						tribe: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					await issuer.addTribe(tribe.address, { from: owner });
					await assert.revert(issuer.addTribe(tribe.address, { from: owner }), 'Tribe exists');
				});

				it('should disallow double adding a Tribe contract with the same currencyKey', async () => {
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
						tribe: 'sXYZ',
						skipInitialAllocation: true,
						supply: 0,
						name: 'XYZ',
						symbol: 'XYZ',
					});

					await issuer.addTribe(tribe1.address, { from: owner });
					await assert.revert(issuer.addTribe(tribe2.address, { from: owner }), 'Tribe exists');
				});

				describe('when another tribe is added with 0 supply', () => {
					let currencyKey, tribe, tribeProxy;

					beforeEach(async () => {
						const symbol = 'hBTC';
						currencyKey = toBytes32(symbol);

						({ token: tribe, proxy: tribeProxy } = await mockToken({
							tribe: symbol,
							accounts,
							name: 'test',
							symbol,
							supply: 0,
							skipInitialAllocation: true,
						}));

						await issuer.addTribe(tribe.address, { from: owner });
						await setupPriceAggregators(exchangeRates, owner, [currencyKey]);
					});

					it('should be able to query multiple tribe addresses', async () => {
						const tribeAddresses = await issuer.getTribes([currencyKey, hETH, hUSD]);
						assert.equal(tribeAddresses[0], tribe.address);
						assert.equal(tribeAddresses[1], hETHContract.address);
						assert.equal(tribeAddresses[2], hUSDContract.address);
						assert.equal(tribeAddresses.length, 3);
					});

					it('should allow removing a Tribe contract when it has no issued balance', async () => {
						const tribeCount = await tribeone.availableTribeCount();

						assert.notEqual(await tribeone.tribes(currencyKey), ZERO_ADDRESS);

						const txn = await issuer.removeTribe(currencyKey, { from: owner });

						// Assert that we have one less tribe, and that the specific currency key is gone.
						assert.bnEqual(
							await tribeone.availableTribeCount(),
							tribeCount.sub(web3.utils.toBN(1))
						);
						assert.equal(await tribeone.tribes(currencyKey), ZERO_ADDRESS);

						assert.eventEqual(txn, 'TribeRemoved', [currencyKey, tribe.address]);
					});

					it('should disallow removing a token by a non-owner', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: issuer.removeTribe,
							args: [currencyKey],
							accounts,
							address: owner,
							reason: 'Only the contract owner may perform this action',
						});
					});

					describe('when that tribe has issued but has no rate', () => {
						beforeEach(async () => {
							await tribe.issue(account1, toUnit('100'));
						});
						it('should disallow removing a Tribe contract when it has an issued balance and no rate', async () => {
							// Assert that we can't remove the tribe now
							await assert.revert(
								issuer.removeTribe(currencyKey, { from: owner }),
								'Cannot remove without rate'
							);
						});
						describe('when the tribe has a rate', () => {
							beforeEach(async () => {
								await updateAggregatorRates(
									exchangeRates,
									circuitBreaker,
									[currencyKey],
									[toUnit('2')]
								);
							});

							describe('when another user exchanges into the tribe', () => {
								beforeEach(async () => {
									await hUSDContract.issue(account2, toUnit('1000'));
									await tribeone.exchange(hUSD, toUnit('100'), currencyKey, { from: account2 });
								});
								describe('when the tribe is removed', () => {
									beforeEach(async () => {
										await issuer.removeTribe(currencyKey, { from: owner });
									});
									it('then settling works as expected', async () => {
										await tribeone.settle(currencyKey);

										const { numEntries } = await exchanger.settlementOwing(owner, currencyKey);
										assert.equal(numEntries, '0');
									});
								});
								describe('when the same user exchanges out of the tribe', () => {
									beforeEach(async () => {
										await setExchangeWaitingPeriod({ owner, systemSettings, secs: 60 });
										// pass through the waiting period so we can exchange again
										await fastForward(90);
										await tribeone.exchange(currencyKey, toUnit('1'), hUSD, { from: account2 });
									});
									describe('when the tribe is removed', () => {
										beforeEach(async () => {
											await issuer.removeTribe(currencyKey, { from: owner });
										});
										it('then settling works as expected', async () => {
											await tribeone.settle(hUSD);

											const { numEntries } = await exchanger.settlementOwing(owner, hUSD);
											assert.equal(numEntries, '0');
										});
										it('then settling from the original currency works too', async () => {
											await tribeone.settle(currencyKey);
											const { numEntries } = await exchanger.settlementOwing(owner, currencyKey);
											assert.equal(numEntries, '0');
										});
									});
								});
							});

							describe('when a debt snapshot is taken', () => {
								let totalIssuedTribes;
								beforeEach(async () => {
									await updateDebtMonitors();

									totalIssuedTribes = await issuer.totalIssuedTribes(hUSD, true);

									// 100 hETH at 2 per hETH is 200 total debt
									assert.bnEqual(totalIssuedTribes, toUnit('200'));
								});
								describe('when the tribe is removed', () => {
									let txn;
									beforeEach(async () => {
										// base conditions
										assert.equal(await hUSDContract.balanceOf(tribeRedeemer.address), '0');
										assert.equal(await tribeRedeemer.redemptions(tribeProxy.address), '0');

										// now do the removal
										txn = await issuer.removeTribe(currencyKey, { from: owner });
									});
									it('emits an event', async () => {
										assert.eventEqual(txn, 'TribeRemoved', [currencyKey, tribe.address]);
									});
									it('issues the equivalent amount of hUSD', async () => {
										const amountOfhUSDIssued = await hUSDContract.balanceOf(tribeRedeemer.address);

										// 100 units of hBTC at a rate of 2:1
										assert.bnEqual(amountOfhUSDIssued, toUnit('200'));
									});
									it('it invokes deprecate on the redeemer via the proxy', async () => {
										const redeemRate = await tribeRedeemer.redemptions(tribeProxy.address);

										assert.bnEqual(redeemRate, toUnit('2'));
									});
									it('and total debt remains unchanged', async () => {
										assert.bnEqual(await issuer.totalIssuedTribes(hUSD, true), totalIssuedTribes);
									});
								});
							});
						});
					});
				});

				describe('multiple add/remove tribes', () => {
					let currencyKey, tribe;

					beforeEach(async () => {
						const symbol = 'hBTC';
						currencyKey = toBytes32(symbol);

						({ token: tribe } = await mockToken({
							tribe: symbol,
							accounts,
							name: 'test',
							symbol,
							supply: 0,
							skipInitialAllocation: true,
						}));

						await issuer.addTribe(tribe.address, { from: owner });
					});

					it('should allow adding multiple Tribe contracts at once', async () => {
						const previousTribeCount = await tribeone.availableTribeCount();

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

						const txn = await issuer.addTribes([tribe1.address, tribe2.address], { from: owner });

						const currencyKey1 = toBytes32('sXYZ');
						const currencyKey2 = toBytes32('sABC');

						// Assert that we've successfully added two Tribes
						assert.bnEqual(
							await tribeone.availableTribeCount(),
							previousTribeCount.add(web3.utils.toBN(2))
						);
						// Assert that they're at the end of the array
						assert.equal(await tribeone.availableTribes(previousTribeCount), tribe1.address);
						assert.equal(
							await tribeone.availableTribes(previousTribeCount.add(web3.utils.toBN(1))),
							tribe2.address
						);
						// Assert that they are retrievable by currencyKey
						assert.equal(await tribeone.tribes(currencyKey1), tribe1.address);
						assert.equal(await tribeone.tribes(currencyKey2), tribe2.address);

						// Assert events emitted
						assert.eventEqual(txn.logs[0], 'TribeAdded', [currencyKey1, tribe1.address]);
						assert.eventEqual(txn.logs[1], 'TribeAdded', [currencyKey2, tribe2.address]);
					});

					it('should disallow multi-adding the same Tribe contract', async () => {
						const { token: tribe } = await mockToken({
							accounts,
							tribe: 'sXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						await assert.revert(
							issuer.addTribes([tribe.address, tribe.address], { from: owner }),
							'Tribe exists'
						);
					});

					it('should disallow multi-adding tribe contracts with the same currency key', async () => {
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
							tribe: 'sXYZ',
							skipInitialAllocation: true,
							supply: 0,
							name: 'XYZ',
							symbol: 'XYZ',
						});

						await assert.revert(
							issuer.addTribes([tribe1.address, tribe2.address], { from: owner }),
							'Tribe exists'
						);
					});

					it('should disallow removing non-existent tribes', async () => {
						const fakeCurrencyKey = toBytes32('NOPE');

						// Assert that we can't remove the tribe
						await assert.revert(
							issuer.removeTribes([currencyKey, fakeCurrencyKey], { from: owner }),
							'Tribe does not exist'
						);
					});

					it('should disallow removing hUSD', async () => {
						// Assert that we can't remove hUSD
						await assert.revert(
							issuer.removeTribes([currencyKey, hUSD], { from: owner }),
							'Cannot remove tribe'
						);
					});

					it('should allow removing tribes with no balance', async () => {
						const symbol2 = 'sFOO';
						const currencyKey2 = toBytes32(symbol2);

						const { token: tribe2 } = await mockToken({
							tribe: symbol2,
							accounts,
							name: 'foo',
							symbol2,
							supply: 0,
							skipInitialAllocation: true,
						});

						await issuer.addTribe(tribe2.address, { from: owner });

						const previousTribeCount = await tribeone.availableTribeCount();

						const tx = await issuer.removeTribes([currencyKey, currencyKey2], { from: owner });

						assert.bnEqual(
							await tribeone.availableTribeCount(),
							previousTribeCount.sub(web3.utils.toBN(2))
						);

						// Assert events emitted
						assert.eventEqual(tx.logs[0], 'TribeRemoved', [currencyKey, tribe.address]);
						assert.eventEqual(tx.logs[1], 'TribeRemoved', [currencyKey2, tribe2.address]);
					});
				});
			});

			describe('issuance', () => {
				describe('potential blocking conditions', () => {
					beforeEach(async () => {
						// ensure user has tribes to issue from
						await tribeone.transfer(account1, toUnit('1000'), { from: owner });
					});

					['System', 'Issuance'].forEach(section => {
						describe(`when ${section} is suspended`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: true });
							});
							it('then calling issue() reverts', async () => {
								await assert.revert(
									tribeone.issueTribes(toUnit('1'), { from: account1 }),
									'Operation prohibited'
								);
							});
							it('and calling issueMaxTribes() reverts', async () => {
								await assert.revert(
									tribeone.issueMaxTribes({ from: account1 }),
									'Operation prohibited'
								);
							});
							describe(`when ${section} is resumed`, () => {
								beforeEach(async () => {
									await setStatus({ owner, systemStatus, section, suspend: false });
								});
								it('then calling issue() succeeds', async () => {
									await tribeone.issueTribes(toUnit('1'), { from: account1 });
								});
								it('and calling issueMaxTribes() succeeds', async () => {
									await tribeone.issueMaxTribes({ from: account1 });
								});
							});
						});
					});
					describe(`when wHAKA is stale`, () => {
						beforeEach(async () => {
							await fastForward(
								(await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300'))
							);
							await updateDebtMonitors();
						});

						it('reverts on issueTribes()', async () => {
							await assert.revert(
								tribeone.issueTribes(toUnit('1'), { from: account1 }),
								'A tribe or wHAKA rate is invalid'
							);
						});
						it('reverts on issueMaxTribes()', async () => {
							await assert.revert(
								tribeone.issueMaxTribes({ from: account1 }),
								'A tribe or wHAKA rate is invalid'
							);
						});
					});

					describe(`when debt aggregator is stale`, () => {
						beforeEach(async () => {
							await aggregatorDebtRatio.setOverrideTimestamp(500); // really old timestamp
						});

						it('reverts on issueTribes()', async () => {
							await assert.revert(
								tribeone.issueTribes(toUnit('1'), { from: account1 }),
								'A tribe or wHAKA rate is invalid'
							);
						});
						it('reverts on issueMaxTribes()', async () => {
							await assert.revert(
								tribeone.issueMaxTribes({ from: account1 }),
								'A tribe or wHAKA rate is invalid'
							);
						});
					});
				});
				it('should allow the issuance of a small amount of tribes', async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('1000'), { from: owner });

					// account1 should be able to issue
					// Note: If a too small amount of tribes are issued here, the amount may be
					// rounded to 0 in the debt register. This will revert. As such, there is a minimum
					// number of tribes that need to be issued each time issue is invoked. The exact
					// amount depends on the Tribe exchange rate and the total supply.
					await tribeone.issueTribes(web3.utils.toBN('5'), { from: account1 });
				});

				it('should be possible to issue the maximum amount of tribes via issueTribes', async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('1000'), { from: owner });

					const maxTribes = await tribeone.maxIssuableTribes(account1);

					// account1 should be able to issue
					await tribeone.issueTribes(maxTribes, { from: account1 });
				});

				it('should allow an issuer to issue tribes in one flavour', async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('1000'), { from: owner });

					// account1 should be able to issue
					await tribeone.issueTribes(toUnit('10'), { from: account1 });

					// There should be 10 hUSD of value in the system
					assert.bnEqual(await tribeone.totalIssuedTribes(hUSD), toUnit('10'));

					// And account1 should own 100% of the debt.
					assert.bnEqual(await tribeone.totalIssuedTribes(hUSD), toUnit('10'));
					assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('10'));
				});

				// TODO: Check that the rounding errors are acceptable
				it('should allow two issuers to issue tribes in one flavour', async () => {
					// Give some wHAKA to account1 and account2
					await tribeone.transfer(account1, toUnit('10000'), {
						from: owner,
					});
					await tribeone.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await tribeone.issueTribes(toUnit('10'), { from: account1 });
					await tribeone.issueTribes(toUnit('20'), { from: account2 });

					// There should be 30hUSD of value in the system
					assert.bnEqual(await tribeone.totalIssuedTribes(hUSD), toUnit('30'));

					// And the debt should be split 50/50.
					// But there's a small rounding error.
					// This is ok, as when the last person exits the system, their debt percentage is always 100% so
					// these rounding errors don't cause the system to be out of balance.
					assert.bnClose(await tribeone.debtBalanceOf(account1, hUSD), toUnit('10'));
					assert.bnClose(await tribeone.debtBalanceOf(account2, hUSD), toUnit('20'));
				});

				it('should allow multi-issuance in one flavour', async () => {
					// Give some wHAKA to account1 and account2
					await tribeone.transfer(account1, toUnit('10000'), {
						from: owner,
					});
					await tribeone.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await tribeone.issueTribes(toUnit('10'), { from: account1 });
					await tribeone.issueTribes(toUnit('20'), { from: account2 });
					await tribeone.issueTribes(toUnit('10'), { from: account1 });

					// There should be 40 hUSD of value in the system
					assert.bnEqual(await tribeone.totalIssuedTribes(hUSD), toUnit('40'));

					// And the debt should be split 50/50.
					// But there's a small rounding error.
					// This is ok, as when the last person exits the system, their debt percentage is always 100% so
					// these rounding errors don't cause the system to be out of balance.
					assert.bnClose(await tribeone.debtBalanceOf(account1, hUSD), toUnit('20'));
					assert.bnClose(await tribeone.debtBalanceOf(account2, hUSD), toUnit('20'));
				});

				describe('issueTribesWithoutDebt', () => {
					describe('successfully invoked', () => {
						let beforeCachedDebt;

						beforeEach(async () => {
							beforeCachedDebt = await debtCache.cachedDebt();

							await issuer.issueTribesWithoutDebt(hETH, owner, toUnit(100), {
								from: tribeetixBridgeToOptimism,
							});
						});

						it('issues tribes', async () => {
							assert.bnEqual(await hETHContract.balanceOf(owner), toUnit(100));
						});

						it('maintains debt cache', async () => {
							assert.bnEqual(await debtCache.cachedDebt(), beforeCachedDebt.add(toUnit(20000)));
						});
					});
				});

				describe('burnTribesWithoutDebt', () => {
					describe('successfully invoked', () => {
						let beforeCachedDebt;

						beforeEach(async () => {
							beforeCachedDebt = await debtCache.cachedDebt();
							await issuer.issueTribesWithoutDebt(hETH, owner, toUnit(100), {
								from: tribeetixBridgeToOptimism,
							});
							await issuer.burnTribesWithoutDebt(hETH, owner, toUnit(50), {
								from: tribeetixBridgeToOptimism,
							});
						});

						it('burns tribes', async () => {
							assert.bnEqual(await hETHContract.balanceOf(owner), toUnit(50));
						});

						it('maintains debt cache', async () => {
							assert.bnEqual(await debtCache.cachedDebt(), beforeCachedDebt.add(toUnit(10000)));
						});
					});
				});

				describe('issueMaxTribes', () => {
					it('should allow an issuer to issue max tribes in one flavour', async () => {
						// Give some wHAKA to account1
						await tribeone.transfer(account1, toUnit('10000'), {
							from: owner,
						});

						// Issue
						await tribeone.issueMaxTribes({ from: account1 });

						// There should be 200 hUSD of value in the system
						assert.bnEqual(await tribeone.totalIssuedTribes(hUSD), toUnit('200'));

						// And account1 should own all of it.
						assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('200'));
					});
				});

				it('should allow an issuer to issue max tribes via the standard issue call', async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Determine maximum amount that can be issued.
					const maxIssuable = await tribeone.maxIssuableTribes(account1);

					// Issue
					await tribeone.issueTribes(maxIssuable, { from: account1 });

					// There should be 200 hUSD of value in the system
					assert.bnEqual(await tribeone.totalIssuedTribes(hUSD), toUnit('200'));

					// And account1 should own all of it.
					assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('200'));
				});

				it('should disallow an issuer from issuing tribes beyond their remainingIssuableTribes', async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// They should now be able to issue hUSD
					let issuableTribes = await issuer.remainingIssuableTribes(account1);
					assert.bnEqual(issuableTribes.maxIssuable, toUnit('200'));

					// Issue that amount.
					await tribeone.issueTribes(issuableTribes.maxIssuable, { from: account1 });

					// They should now have 0 issuable tribes.
					issuableTribes = await issuer.remainingIssuableTribes(account1);
					assert.bnEqual(issuableTribes.maxIssuable, '0');

					// And trying to issue the smallest possible unit of one should fail.
					await assert.revert(tribeone.issueTribes('1', { from: account1 }), 'Amount too large');
				});

				it('circuit breaks when debt changes dramatically', async () => {
					await tribeone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// debt must start at 0
					assert.bnEqual(await tribeone.totalIssuedTribes(hUSD), toUnit(0));

					// They should now be able to issue hUSD
					await tribeone.issueTribes(toUnit('100'), { from: account1 });
					await updateDebtMonitors();
					await tribeone.issueTribes(toUnit('1'), { from: account1 });
					await updateDebtMonitors();

					assert.bnEqual(await hUSDContract.balanceOf(account1), toUnit('101'));

					await hUSDContract.issue(account1, toUnit('10000000'));
					await debtCache.takeDebtSnapshot();

					assert.bnEqual(await hUSDContract.balanceOf(account1), toUnit('10000101'));

					// trigger circuit breaking
					await tribeone.issueTribes(toUnit('1'), { from: account1 });

					assert.bnEqual(await hUSDContract.balanceOf(account1), toUnit('10000101'));

					// undo
					await hUSDContract.burn(account1, toUnit('10000000'));

					// circuit is still broken
					await tribeone.issueTribes(toUnit('1'), { from: account1 });
					await tribeone.issueTribes(toUnit('1'), { from: account1 });

					assert.bnEqual(await hUSDContract.balanceOf(account1), toUnit('101'));
				});
			});

			describe('burning', () => {
				it('circuit breaks when debt changes dramatically', async () => {
					await tribeone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// They should now be able to issue hUSD
					await tribeone.issueTribes(toUnit('100'), { from: account1 });
					await updateDebtMonitors();
					await tribeone.burnTribes(toUnit('1'), { from: account1 });

					// burn the rest of the tribes without getting rid of debt shares
					await hUSDContract.burn(account1, toUnit('90'));
					await debtCache.takeDebtSnapshot();

					// all debt should be burned here
					assert.bnEqual(await hUSDContract.balanceOf(account1), toUnit(9));

					// trigger circuit breaking (not reverting here is part of the test)
					await tribeone.burnTribes('1', { from: account1 });

					// debt should not have changed
					assert.bnEqual(await hUSDContract.balanceOf(account1), toUnit(9));

					// mint it back
					await hUSDContract.issue(account1, toUnit('90'));

					await tribeone.burnTribes('1', { from: account1 });
					await tribeone.burnTribes('1', { from: account1 });

					// debt should not have changed
					assert.bnEqual(await hUSDContract.balanceOf(account1), toUnit(99));
				});

				describe('potential blocking conditions', () => {
					beforeEach(async () => {
						// ensure user has tribes to burb
						await tribeone.transfer(account1, toUnit('1000'), { from: owner });
						await tribeone.issueMaxTribes({ from: account1 });
					});
					['System', 'Issuance'].forEach(section => {
						describe(`when ${section} is suspended`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: true });
							});
							it('then calling burn() reverts', async () => {
								await assert.revert(
									tribeone.burnTribes(toUnit('1'), { from: account1 }),
									'Operation prohibited'
								);
							});
							it('and calling burnTribesToTarget() reverts', async () => {
								await assert.revert(
									tribeone.burnTribesToTarget({ from: account1 }),
									'Operation prohibited'
								);
							});
							describe(`when ${section} is resumed`, () => {
								beforeEach(async () => {
									await setStatus({ owner, systemStatus, section, suspend: false });
								});
								it('then calling burnTribes() succeeds', async () => {
									await tribeone.burnTribes(toUnit('1'), { from: account1 });
								});
								it('and calling burnTribesToTarget() succeeds', async () => {
									await tribeone.burnTribesToTarget({ from: account1 });
								});
							});
						});
					});

					describe(`when wHAKA is stale`, () => {
						beforeEach(async () => {
							await fastForward(
								(await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300'))
							);
							await updateDebtMonitors();
						});

						it('then calling burn() reverts', async () => {
							await assert.revert(
								tribeone.burnTribes(toUnit('1'), { from: account1 }),
								'A tribe or wHAKA rate is invalid'
							);
						});
						it('and calling burnTribesToTarget() reverts', async () => {
							await assert.revert(
								tribeone.burnTribesToTarget({ from: account1 }),
								'A tribe or wHAKA rate is invalid'
							);
						});
					});

					describe(`when debt aggregator is stale`, () => {
						beforeEach(async () => {
							await aggregatorDebtRatio.setOverrideTimestamp(500);
						});

						it('then calling burn() reverts', async () => {
							await assert.revert(
								tribeone.burnTribes(toUnit('1'), { from: account1 }),
								'A tribe or wHAKA rate is invalid'
							);
						});
						it('and calling burnTribesToTarget() reverts', async () => {
							await assert.revert(
								tribeone.burnTribesToTarget({ from: account1 }),
								'A tribe or wHAKA rate is invalid'
							);
						});
					});
				});

				it('should allow an issuer with outstanding debt to burn tribes and decrease debt', async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await tribeone.issueMaxTribes({ from: account1 });

					// account1 should now have 200 hUSD of debt.
					assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('200'));

					// Burn 100 hUSD
					await tribeone.burnTribes(toUnit('100'), { from: account1 });

					// account1 should now have 100 hUSD of debt.
					assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('100'));
				});

				it('should disallow an issuer without outstanding debt from burning tribes', async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await tribeone.issueMaxTribes({ from: account1 });

					// account2 should not have anything and can't burn.
					await assert.revert(
						tribeone.burnTribes(toUnit('10'), { from: account2 }),
						'No debt to forgive'
					);

					// And even when we give account2 tribes, it should not be able to burn.
					await hUSDContract.transfer(account2, toUnit('100'), {
						from: account1,
					});

					await assert.revert(
						tribeone.burnTribes(toUnit('10'), { from: account2 }),
						'No debt to forgive'
					);
				});

				it('should revert when trying to burn tribes that do not exist', async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await tribeone.issueMaxTribes({ from: account1 });

					// Transfer all newly issued tribes to account2
					await hUSDContract.transfer(account2, toUnit('200'), {
						from: account1,
					});

					const debtBefore = await tribeone.debtBalanceOf(account1, hUSD);

					assert.ok(!debtBefore.isNeg());

					// Burning any amount of hUSD beyond what is owned will cause a revert
					await assert.revert(
						tribeone.burnTribes('1', { from: account1 }),
						'SafeMath: subtraction overflow'
					);
				});

				it("should only burn up to a user's actual debt level", async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('10000'), {
						from: owner,
					});
					await tribeone.transfer(account2, toUnit('10000'), {
						from: owner,
					});

					// Issue
					const fullAmount = toUnit('210');
					const account1Payment = toUnit('10');
					const account2Payment = fullAmount.sub(account1Payment);
					await tribeone.issueTribes(account1Payment, { from: account1 });
					await tribeone.issueTribes(account2Payment, { from: account2 });

					// Transfer all of account2's tribes to account1
					const amountTransferred = toUnit('200');
					await hUSDContract.transfer(account1, amountTransferred, {
						from: account2,
					});
					// return;

					const balanceOfAccount1 = await hUSDContract.balanceOf(account1);

					// Then try to burn them all. Only 10 tribes (and fees) should be gone.
					await tribeone.burnTribes(balanceOfAccount1, { from: account1 });
					const balanceOfAccount1AfterBurn = await hUSDContract.balanceOf(account1);

					// Recording debts in the debt ledger reduces accuracy.
					//   Let's allow for a 1000 margin of error.
					assert.bnClose(balanceOfAccount1AfterBurn, amountTransferred, '1000');
				});

				it("should successfully burn all user's tribes @gasprofile", async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('10000'), {
						from: owner,
					});

					// Issue
					await tribeone.issueTribes(toUnit('199'), { from: account1 });

					// Then try to burn them all. Only 10 tribes (and fees) should be gone.
					await tribeone.burnTribes(await hUSDContract.balanceOf(account1), {
						from: account1,
					});

					assert.bnEqual(await hUSDContract.balanceOf(account1), web3.utils.toBN(0));
				});

				it('should burn the correct amount of tribes', async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await tribeone.transfer(account2, toUnit('200000'), {
						from: owner,
					});

					// Issue
					await tribeone.issueTribes(toUnit('199'), { from: account1 });

					// Then try to burn them all. Only 10 tribes (and fees) should be gone.
					await tribeone.burnTribes(await hUSDContract.balanceOf(account1), {
						from: account1,
					});

					assert.bnEqual(await hUSDContract.balanceOf(account1), web3.utils.toBN(0));
				});

				it('should burn the correct amount of tribes', async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await tribeone.transfer(account2, toUnit('200000'), {
						from: owner,
					});

					// Issue
					const issuedTribesPt1 = toUnit('2000');
					const issuedTribesPt2 = toUnit('2000');
					await tribeone.issueTribes(issuedTribesPt1, { from: account1 });
					await tribeone.issueTribes(issuedTribesPt2, { from: account1 });
					await tribeone.issueTribes(toUnit('1000'), { from: account2 });

					const debt = await tribeone.debtBalanceOf(account1, hUSD);
					assert.bnClose(debt, toUnit('4000'));
				});

				describe('debt calculation in multi-issuance scenarios', () => {
					it('should correctly calculate debt in a multi-issuance multi-burn scenario @gasprofile', async () => {
						// Give some wHAKA to account1
						await tribeone.transfer(account1, toUnit('500000'), {
							from: owner,
						});
						await tribeone.transfer(account2, toUnit('140000'), {
							from: owner,
						});
						await tribeone.transfer(account3, toUnit('1400000'), {
							from: owner,
						});

						// Issue
						const issuedTribes1 = toUnit('2000');
						const issuedTribes2 = toUnit('2000');
						const issuedTribes3 = toUnit('2000');

						// Send more than their tribe balance to burn all
						const burnAllTribes = toUnit('2050');

						await tribeone.issueTribes(issuedTribes1, { from: account1 });
						await tribeone.issueTribes(issuedTribes2, { from: account2 });
						await tribeone.issueTribes(issuedTribes3, { from: account3 });

						await tribeone.burnTribes(burnAllTribes, { from: account1 });
						await tribeone.burnTribes(burnAllTribes, { from: account2 });
						await tribeone.burnTribes(burnAllTribes, { from: account3 });

						const debtBalance1After = await tribeone.debtBalanceOf(account1, hUSD);
						const debtBalance2After = await tribeone.debtBalanceOf(account2, hUSD);
						const debtBalance3After = await tribeone.debtBalanceOf(account3, hUSD);

						assert.bnEqual(debtBalance1After, '0');
						assert.bnEqual(debtBalance2After, '0');
						assert.bnEqual(debtBalance3After, '0');
					});

					it('should allow user to burn all tribes issued even after other users have issued', async () => {
						// Give some wHAKA to account1
						await tribeone.transfer(account1, toUnit('500000'), {
							from: owner,
						});
						await tribeone.transfer(account2, toUnit('140000'), {
							from: owner,
						});
						await tribeone.transfer(account3, toUnit('1400000'), {
							from: owner,
						});

						// Issue
						const issuedTribes1 = toUnit('2000');
						const issuedTribes2 = toUnit('2000');
						const issuedTribes3 = toUnit('2000');

						await tribeone.issueTribes(issuedTribes1, { from: account1 });
						await tribeone.issueTribes(issuedTribes2, { from: account2 });
						await tribeone.issueTribes(issuedTribes3, { from: account3 });

						const debtBalanceBefore = await tribeone.debtBalanceOf(account1, hUSD);
						await tribeone.burnTribes(debtBalanceBefore, { from: account1 });
						const debtBalanceAfter = await tribeone.debtBalanceOf(account1, hUSD);

						assert.bnEqual(debtBalanceAfter, '0');
					});

					it('should allow a user to burn up to their balance if they try too burn too much', async () => {
						// Give some wHAKA to account1
						await tribeone.transfer(account1, toUnit('500000'), {
							from: owner,
						});

						// Issue
						const issuedTribes1 = toUnit('10');

						await tribeone.issueTribes(issuedTribes1, { from: account1 });
						await tribeone.burnTribes(issuedTribes1.add(toUnit('9000')), {
							from: account1,
						});
						const debtBalanceAfter = await tribeone.debtBalanceOf(account1, hUSD);

						assert.bnEqual(debtBalanceAfter, '0');
					});

					it('should allow users to burn their debt and adjust the debtBalanceOf correctly for remaining users', async () => {
						// Give some wHAKA to account1
						await tribeone.transfer(account1, toUnit('40000000'), {
							from: owner,
						});
						await tribeone.transfer(account2, toUnit('40000000'), {
							from: owner,
						});

						// Issue
						const issuedTribes1 = toUnit('150000');
						const issuedTribes2 = toUnit('50000');

						await tribeone.issueTribes(issuedTribes1, { from: account1 });
						await tribeone.issueTribes(issuedTribes2, { from: account2 });

						let debtBalance1After = await tribeone.debtBalanceOf(account1, hUSD);
						let debtBalance2After = await tribeone.debtBalanceOf(account2, hUSD);

						// debtBalanceOf has rounding error but is within tolerance
						assert.bnClose(debtBalance1After, toUnit('150000'), '100000');
						assert.bnClose(debtBalance2After, toUnit('50000'), '100000');

						// Account 1 burns 100,000
						await tribeone.burnTribes(toUnit('100000'), { from: account1 });

						debtBalance1After = await tribeone.debtBalanceOf(account1, hUSD);
						debtBalance2After = await tribeone.debtBalanceOf(account2, hUSD);

						assert.bnClose(debtBalance1After, toUnit('50000'), '100000');
						assert.bnClose(debtBalance2After, toUnit('50000'), '100000');
					});

					it('should revert if sender tries to issue tribes with 0 amount', async () => {
						// Issue 0 amount of tribe
						const issuedTribes1 = toUnit('0');

						await assert.revert(
							tribeone.issueTribes(issuedTribes1, { from: account1 }),
							'cannot issue 0 tribes'
						);
					});
				});

				describe('burnTribesToTarget', () => {
					beforeEach(async () => {
						// Give some wHAKA to account1
						await tribeone.transfer(account1, toUnit('40000'), {
							from: owner,
						});
						// Set wHAKA price to 1
						await updateAggregatorRates(exchangeRates, circuitBreaker, [wHAKA], ['1'].map(toUnit));
						await updateDebtMonitors();

						// Issue
						await tribeone.issueMaxTribes({ from: account1 });
						assert.bnClose(await tribeone.debtBalanceOf(account1, hUSD), toUnit('8000'));

						// Set minimumStakeTime to 1 hour
						await systemSettings.setMinimumStakeTime(60 * 60, { from: owner });
					});

					describe('when the wHAKA price drops 50%', () => {
						let maxIssuableTribes;
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, circuitBreaker, [wHAKA], ['.5'].map(toUnit));
							await updateDebtMonitors();

							maxIssuableTribes = await tribeone.maxIssuableTribes(account1);
							assert.equal(await feePool.isFeesClaimable(account1), false);
						});

						it('then the maxIssuableTribes drops 50%', async () => {
							assert.bnClose(maxIssuableTribes, toUnit('4000'));
						});
						it('then calling burnTribesToTarget() reduces hUSD to c-ratio target', async () => {
							await tribeone.burnTribesToTarget({ from: account1 });
							assert.bnClose(await tribeone.debtBalanceOf(account1, hUSD), toUnit('4000'));
						});
						it('then fees are claimable', async () => {
							await tribeone.burnTribesToTarget({ from: account1 });
							assert.equal(await feePool.isFeesClaimable(account1), true);
						});
					});

					describe('when the wHAKA price drops 10%', () => {
						let maxIssuableTribes;
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, circuitBreaker, [wHAKA], ['.9'].map(toUnit));
							await updateDebtMonitors();

							maxIssuableTribes = await tribeone.maxIssuableTribes(account1);
						});

						it('then the maxIssuableTribes drops 10%', async () => {
							assert.bnEqual(maxIssuableTribes, toUnit('7200'));
						});
						it('then calling burnTribesToTarget() reduces hUSD to c-ratio target', async () => {
							await tribeone.burnTribesToTarget({ from: account1 });
							assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('7200'));
						});
						it('then fees are claimable', async () => {
							await tribeone.burnTribesToTarget({ from: account1 });
							assert.equal(await feePool.isFeesClaimable(account1), true);
						});
					});

					describe('when the wHAKA price drops 90%', () => {
						let maxIssuableTribes;
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, circuitBreaker, [wHAKA], ['.1'].map(toUnit));
							await updateDebtMonitors();

							maxIssuableTribes = await tribeone.maxIssuableTribes(account1);
						});

						it('then the maxIssuableTribes drops 10%', async () => {
							assert.bnEqual(maxIssuableTribes, toUnit('800'));
						});
						it('then calling burnTribesToTarget() reduces hUSD to c-ratio target', async () => {
							await tribeone.burnTribesToTarget({ from: account1 });
							assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('800'));
						});
						it('then fees are claimable', async () => {
							await tribeone.burnTribesToTarget({ from: account1 });
							assert.equal(await feePool.isFeesClaimable(account1), true);
						});
					});

					describe('when the wHAKA price increases 100%', () => {
						let maxIssuableTribes;
						beforeEach(async () => {
							await updateAggregatorRates(exchangeRates, circuitBreaker, [wHAKA], ['2'].map(toUnit));
							await updateDebtMonitors();

							maxIssuableTribes = await tribeone.maxIssuableTribes(account1);
						});

						it('then the maxIssuableTribes increases 100%', async () => {
							assert.bnEqual(maxIssuableTribes, toUnit('16000'));
						});
						it('then calling burnTribesToTarget() reverts', async () => {
							await assert.revert(
								tribeone.burnTribesToTarget({ from: account1 }),
								'SafeMath: subtraction overflow'
							);
						});
					});
				});

				describe('burnTribes() after exchange()', () => {
					describe('given the waiting period is set to 60s', () => {
						let amount;
						const exchangeFeeRate = toUnit('0');
						beforeEach(async () => {
							amount = toUnit('1250');
							await setExchangeWaitingPeriod({ owner, systemSettings, secs: 60 });

							// set the exchange fee to 0 to effectively ignore it
							await setExchangeFeeRateForTribes({
								owner,
								systemSettings,
								tribeKeys,
								exchangeFeeRates: tribeKeys.map(() => exchangeFeeRate),
							});
						});
						describe('and a user has 1250 hUSD issued', () => {
							beforeEach(async () => {
								await tribeone.transfer(account1, toUnit('1000000'), { from: owner });
								await tribeone.issueTribes(amount, { from: account1 });
							});
							describe('and is has been exchanged into sEUR at a rate of 1.25:1 and the waiting period has expired', () => {
								beforeEach(async () => {
									await tribeone.exchange(hUSD, amount, sEUR, { from: account1 });
									await fastForward(90); // make sure the waiting period is expired on this
								});
								describe('and they have exchanged all of it back into hUSD', () => {
									beforeEach(async () => {
										await tribeone.exchange(sEUR, toUnit('1000'), hUSD, { from: account1 });
									});
									describe('when they attempt to burn the hUSD', () => {
										it('then it fails as the waiting period is ongoing', async () => {
											await assert.revert(
												tribeone.burnTribes(amount, { from: account1 }),
												'Cannot settle during waiting period'
											);
										});
									});
									describe('and 60s elapses with no change in the sEUR rate', () => {
										beforeEach(async () => {
											fastForward(60);
										});
										describe('when they attempt to burn the hUSD', () => {
											let txn;
											beforeEach(async () => {
												txn = await tribeone.burnTribes(amount, { from: account1 });
											});
											it('then it succeeds and burns the entire hUSD amount', async () => {
												const logs = await getDecodedLogs({
													hash: txn.tx,
													contracts: [tribeone, hUSDContract],
												});

												decodedEventEqual({
													event: 'Burned',
													emittedFrom: hUSDContract.address,
													args: [account1, amount],
													log: logs.find(({ name } = {}) => name === 'Burned'),
												});

												const hUSDBalance = await hUSDContract.balanceOf(account1);
												assert.equal(hUSDBalance, '0');

												const debtBalance = await tribeone.debtBalanceOf(account1, hUSD);
												assert.equal(debtBalance, '0');
											});
										});
									});
									describe('and the sEUR price decreases by 20% to 1', () => {
										beforeEach(async () => {
											await updateAggregatorRates(
												exchangeRates,
												circuitBreaker,
												[sEUR],
												['1'].map(toUnit)
											);
											await updateDebtMonitors();
										});
										describe('and 60s elapses', () => {
											beforeEach(async () => {
												fastForward(60);
											});
											describe('when they attempt to burn the entire amount hUSD', () => {
												let txn;
												beforeEach(async () => {
													txn = await tribeone.burnTribes(amount, { from: account1 });
												});
												it('then it succeeds and burns their hUSD minus the reclaim amount from settlement', async () => {
													const logs = await getDecodedLogs({
														hash: txn.tx,
														contracts: [tribeone, hUSDContract],
													});

													decodedEventEqual({
														event: 'Burned',
														emittedFrom: hUSDContract.address,
														args: [account1, amount.sub(toUnit('250'))],
														log: logs
															.reverse()
															.filter(l => !!l)
															.find(({ name }) => name === 'Burned'),
													});

													const hUSDBalance = await hUSDContract.balanceOf(account1);
													assert.equal(hUSDBalance, '0');
												});
												it('and their debt balance is now 0 because they are the only debt holder in the system', async () => {
													// the debt balance remaining is what was reclaimed from the exchange
													const debtBalance = await tribeone.debtBalanceOf(account1, hUSD);
													// because this user is the only one holding debt, when we burn 250 hUSD in a reclaim,
													// it removes it from the totalIssuedTribes and
													assert.equal(debtBalance, '0');
												});
											});
											describe('when another user also has the same amount of debt', () => {
												beforeEach(async () => {
													await tribeone.transfer(account2, toUnit('1000000'), { from: owner });
													await tribeone.issueTribes(amount, { from: account2 });
												});
												describe('when the first user attempts to burn the entire amount hUSD', () => {
													let txn;
													beforeEach(async () => {
														txn = await tribeone.burnTribes(amount, { from: account1 });
													});
													it('then it succeeds and burns their hUSD minus the reclaim amount from settlement', async () => {
														const logs = await getDecodedLogs({
															hash: txn.tx,
															contracts: [tribeone, hUSDContract],
														});

														decodedEventEqual({
															event: 'Burned',
															emittedFrom: hUSDContract.address,
															args: [account1, amount.sub(toUnit('250'))],
															log: logs
																.reverse()
																.filter(l => !!l)
																.find(({ name }) => name === 'Burned'),
														});

														const hUSDBalance = await hUSDContract.balanceOf(account1);
														assert.equal(hUSDBalance, '0');
													});
													it('and their debt balance is now half of the reclaimed balance because they owe half of the pool', async () => {
														// the debt balance remaining is what was reclaimed from the exchange
														const debtBalance = await tribeone.debtBalanceOf(account1, hUSD);
														// because this user is holding half the debt, when we burn 250 hUSD in a reclaim,
														// it removes it from the totalIssuedTribes and so both users have half of 250
														// in owing tribes
														assert.bnClose(debtBalance, divideDecimal('250', 2), '100000');
													});
												});
											});
										});
									});
								});
							});
						});
					});
				});
			});

			describe('debt calculation in multi-issuance scenarios', () => {
				it('should correctly calculate debt in a multi-issuance scenario', async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('200000'), {
						from: owner,
					});
					await tribeone.transfer(account2, toUnit('200000'), {
						from: owner,
					});

					// Issue
					const issuedTribesPt1 = toUnit('2000');
					const issuedTribesPt2 = toUnit('2000');
					await tribeone.issueTribes(issuedTribesPt1, { from: account1 });
					await tribeone.issueTribes(issuedTribesPt2, { from: account1 });
					await tribeone.issueTribes(toUnit('1000'), { from: account2 });

					const debt = await tribeone.debtBalanceOf(account1, hUSD);
					assert.bnClose(debt, toUnit('4000'));
				});

				it('should correctly calculate debt in a multi-issuance multi-burn scenario', async () => {
					// Give some wHAKA to account1
					await tribeone.transfer(account1, toUnit('500000'), {
						from: owner,
					});
					await tribeone.transfer(account2, toUnit('14000'), {
						from: owner,
					});

					// Issue
					const issuedTribesPt1 = toUnit('2000');
					const burntTribesPt1 = toUnit('1500');
					const issuedTribesPt2 = toUnit('1600');
					const burntTribesPt2 = toUnit('500');

					await tribeone.issueTribes(issuedTribesPt1, { from: account1 });
					await tribeone.burnTribes(burntTribesPt1, { from: account1 });
					await tribeone.issueTribes(issuedTribesPt2, { from: account1 });

					await tribeone.issueTribes(toUnit('100'), { from: account2 });
					await tribeone.issueTribes(toUnit('51'), { from: account2 });
					await tribeone.burnTribes(burntTribesPt2, { from: account1 });

					const debt = await tribeone.debtBalanceOf(account1, toBytes32('hUSD'));
					const expectedDebt = issuedTribesPt1
						.add(issuedTribesPt2)
						.sub(burntTribesPt1)
						.sub(burntTribesPt2);

					assert.bnClose(debt, expectedDebt, '100000');
				});

				it("should allow me to burn all tribes I've issued when there are other issuers", async () => {
					const totalSupply = await tribeone.totalSupply();
					const account2Tribeones = toUnit('120000');
					const account1Tribeones = totalSupply.sub(account2Tribeones);

					await tribeone.transfer(account1, account1Tribeones, {
						from: owner,
					}); // Issue the massive majority to account1
					await tribeone.transfer(account2, account2Tribeones, {
						from: owner,
					}); // Issue a small amount to account2

					// Issue from account1
					const account1AmountToIssue = await tribeone.maxIssuableTribes(account1);
					await tribeone.issueMaxTribes({ from: account1 });
					const debtBalance1 = await tribeone.debtBalanceOf(account1, hUSD);
					assert.bnClose(debtBalance1, account1AmountToIssue);

					// Issue and burn from account 2 all debt
					await tribeone.issueTribes(toUnit('43'), { from: account2 });
					let debt = await tribeone.debtBalanceOf(account2, hUSD);

					// due to rounding it may be necessary to supply higher than originally issued tribes
					await hUSDContract.transfer(account2, toUnit('1'), {
						from: account1,
					});
					await tribeone.burnTribes(toUnit('44'), { from: account2 });
					debt = await tribeone.debtBalanceOf(account2, hUSD);

					assert.bnEqual(debt, 0);
				});
			});

			// These tests take a long time to run
			// ****************************************
			describe('multiple issue and burn scenarios', () => {
				it('should correctly calculate debt in a high issuance and burn scenario', async () => {
					const getRandomInt = (min, max) => {
						return min + Math.floor(Math.random() * Math.floor(max));
					};

					const totalSupply = await tribeone.totalSupply();
					const account2Tribeones = toUnit('120000');
					const account1Tribeones = totalSupply.sub(account2Tribeones);

					await tribeone.transfer(account1, account1Tribeones, {
						from: owner,
					}); // Issue the massive majority to account1
					await tribeone.transfer(account2, account2Tribeones, {
						from: owner,
					}); // Issue a small amount to account2

					const account1AmountToIssue = await tribeone.maxIssuableTribes(account1);
					await tribeone.issueMaxTribes({ from: account1 });
					const debtBalance1 = await tribeone.debtBalanceOf(account1, hUSD);
					assert.bnClose(debtBalance1, account1AmountToIssue);

					let expectedDebtForAccount2 = web3.utils.toBN('0');
					const totalTimesToIssue = 40;
					for (let i = 0; i < totalTimesToIssue; i++) {
						// Seems that in this case, issuing 43 each time leads to increasing the variance regularly each time.
						const amount = toUnit('43');
						await tribeone.issueTribes(amount, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);

						const desiredAmountToBurn = toUnit(web3.utils.toBN(getRandomInt(4, 14)));
						const amountToBurn = desiredAmountToBurn.lte(expectedDebtForAccount2)
							? desiredAmountToBurn
							: expectedDebtForAccount2;
						await tribeone.burnTribes(amountToBurn, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.sub(amountToBurn);

						// Useful debug logging
						// const db = await tribeone.debtBalanceOf(account2, hUSD);
						// const variance = fromUnit(expectedDebtForAccount2.sub(db));
						// console.log(
						// 	`#### debtBalance: ${db}\t\t expectedDebtForAccount2: ${expectedDebtForAccount2}\t\tvariance: ${variance}`
						// );
					}
					const debtBalance = await tribeone.debtBalanceOf(account2, hUSD);

					// Here we make the variance a calculation of the number of times we issue/burn.
					// This is less than ideal, but is the result of calculating the debt based on
					// the results of the issue/burn each time.
					const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('100000000'));
					assert.bnClose(debtBalance, expectedDebtForAccount2, variance);
				}).timeout(60e3);

				it('should correctly calculate debt in a high (random) issuance and burn scenario', async () => {
					const getRandomInt = (min, max) => {
						return min + Math.floor(Math.random() * Math.floor(max));
					};

					const totalSupply = await tribeone.totalSupply();
					const account2Tribeones = toUnit('120000');
					const account1Tribeones = totalSupply.sub(account2Tribeones);

					await tribeone.transfer(account1, account1Tribeones, {
						from: owner,
					}); // Issue the massive majority to account1
					await tribeone.transfer(account2, account2Tribeones, {
						from: owner,
					}); // Issue a small amount to account2

					const account1AmountToIssue = await tribeone.maxIssuableTribes(account1);
					await tribeone.issueMaxTribes({ from: account1 });
					const debtBalance1 = await tribeone.debtBalanceOf(account1, hUSD);
					assert.bnClose(debtBalance1, account1AmountToIssue);

					let expectedDebtForAccount2 = web3.utils.toBN('0');
					const totalTimesToIssue = 40;
					for (let i = 0; i < totalTimesToIssue; i++) {
						// Seems that in this case, issuing 43 each time leads to increasing the variance regularly each time.
						const amount = toUnit(web3.utils.toBN(getRandomInt(40, 49)));
						await tribeone.issueTribes(amount, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);

						const desiredAmountToBurn = toUnit(web3.utils.toBN(getRandomInt(37, 46)));
						const amountToBurn = desiredAmountToBurn.lte(expectedDebtForAccount2)
							? desiredAmountToBurn
							: expectedDebtForAccount2;
						await tribeone.burnTribes(amountToBurn, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.sub(amountToBurn);

						// Useful debug logging
						// const db = await tribeone.debtBalanceOf(account2, hUSD);
						// const variance = fromUnit(expectedDebtForAccount2.sub(db));
						// console.log(
						// 	`#### debtBalance: ${db}\t\t expectedDebtForAccount2: ${expectedDebtForAccount2}\t\tvariance: ${variance}`
						// );
					}
					const debtBalance = await tribeone.debtBalanceOf(account2, hUSD);

					// Here we make the variance a calculation of the number of times we issue/burn.
					// This is less than ideal, but is the result of calculating the debt based on
					// the results of the issue/burn each time.
					const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('100000000')); // max 0.1 gwei of drift per op
					assert.bnClose(debtBalance, expectedDebtForAccount2, variance);
				}).timeout(60e3);

				it('should correctly calculate debt in a high volume contrast issuance and burn scenario', async () => {
					const totalSupply = await tribeone.totalSupply();

					// Give only 100 Tribeone to account2
					const account2Tribeones = toUnit('100');

					// Give the vast majority to account1 (ie. 99,999,900)
					const account1Tribeones = totalSupply.sub(account2Tribeones);

					await tribeone.transfer(account1, account1Tribeones, {
						from: owner,
					}); // Issue the massive majority to account1
					await tribeone.transfer(account2, account2Tribeones, {
						from: owner,
					}); // Issue a small amount to account2

					const account1AmountToIssue = await tribeone.maxIssuableTribes(account1);
					await tribeone.issueMaxTribes({ from: account1 });
					const debtBalance1 = await tribeone.debtBalanceOf(account1, hUSD);
					assert.bnEqual(debtBalance1, account1AmountToIssue);

					let expectedDebtForAccount2 = web3.utils.toBN('0');
					const totalTimesToIssue = 40;
					for (let i = 0; i < totalTimesToIssue; i++) {
						const amount = toUnit('0.000000000000000002');
						await tribeone.issueTribes(amount, { from: account2 });
						expectedDebtForAccount2 = expectedDebtForAccount2.add(amount);
					}
					const debtBalance2 = await tribeone.debtBalanceOf(account2, hUSD);

					// Here we make the variance a calculation of the number of times we issue/burn.
					// This is less than ideal, but is the result of calculating the debt based on
					// the results of the issue/burn each time.
					const variance = web3.utils.toBN(totalTimesToIssue).mul(web3.utils.toBN('2'));
					assert.bnClose(debtBalance2, expectedDebtForAccount2, variance);
				}).timeout(60e3);
			});

			// ****************************************

			it("should prevent more issuance if the user's collaterisation changes to be insufficient", async () => {
				// disable dynamic fee here as it will prevent exchange due to fees spiking too much
				await systemSettings.setExchangeDynamicFeeRounds('0', { from: owner });

				// Set sEUR for purposes of this test
				await updateAggregatorRates(exchangeRates, circuitBreaker, [sEUR], [toUnit('0.75')]);
				await updateDebtMonitors();

				const issuedTribeones = web3.utils.toBN('200000');
				await tribeone.transfer(account1, toUnit(issuedTribeones), {
					from: owner,
				});

				const maxIssuableTribes = await tribeone.maxIssuableTribes(account1);

				// Issue
				const tribesToNotIssueYet = web3.utils.toBN('2000');
				const issuedTribes = maxIssuableTribes.sub(tribesToNotIssueYet);
				await tribeone.issueTribes(issuedTribes, { from: account1 });

				// exchange into sEUR
				await tribeone.exchange(hUSD, issuedTribes, sEUR, { from: account1 });

				// Increase the value of sEUR relative to tribeone
				await updateAggregatorRates(exchangeRates, null, [sEUR], [toUnit('1.1')]);
				await updateDebtMonitors();

				await assert.revert(
					tribeone.issueTribes(tribesToNotIssueYet, { from: account1 }),
					'Amount too large'
				);
			});

			// Check user's collaterisation ratio

			describe('check collaterisation ratio', () => {
				const duration = 52 * WEEK;
				beforeEach(async () => {
					// setup rewardEscrowV2 with mocked feePool address
					await addressResolver.importAddresses([toBytes32('FeePool')], [account6], {
						from: owner,
					});

					// update the cached addresses
					await rewardEscrowV2.rebuildCache({ from: owner });
				});
				it('should return 0 if user has no tribeone when checking the collaterisation ratio', async () => {
					const ratio = await tribeone.collateralisationRatio(account1);
					assert.bnEqual(ratio, new web3.utils.BN(0));
				});

				it('Any user can check the collaterisation ratio for a user', async () => {
					const issuedTribeones = web3.utils.toBN('320000');
					await tribeone.transfer(account1, toUnit(issuedTribeones), {
						from: owner,
					});

					// Issue
					const issuedTribes = toUnit(web3.utils.toBN('6400'));
					await tribeone.issueTribes(issuedTribes, { from: account1 });

					await tribeone.collateralisationRatio(account1, { from: account2 });
				});

				it('should be able to read collaterisation ratio for a user with tribeone but no debt', async () => {
					const issuedTribeones = web3.utils.toBN('30000');
					await tribeone.transfer(account1, toUnit(issuedTribeones), {
						from: owner,
					});

					const ratio = await tribeone.collateralisationRatio(account1);
					assert.bnEqual(ratio, new web3.utils.BN(0));
				});

				it('should be able to read collaterisation ratio for a user with tribeone and debt', async () => {
					const issuedTribeones = web3.utils.toBN('320000');
					await tribeone.transfer(account1, toUnit(issuedTribeones), {
						from: owner,
					});

					// Issue
					const issuedTribes = toUnit(web3.utils.toBN('6400'));
					await tribeone.issueTribes(issuedTribes, { from: account1 });

					const ratio = await tribeone.collateralisationRatio(account1, { from: account2 });
					assert.unitEqual(ratio, '0.2');
				});

				it("should not include escrowed tribeone when calculating a user's collaterisation ratio", async () => {
					const snx2usdRate = await exchangeRates.rateForCurrency(wHAKA);
					const transferredTribeones = toUnit('60000');
					await tribeone.transfer(account1, transferredTribeones, {
						from: owner,
					});

					// Setup escrow
					const oneWeek = 60 * 60 * 24 * 7;
					const twelveWeeks = oneWeek * 12;
					const now = await currentTime();
					const escrowedTribeones = toUnit('30000');
					await tribeone.transfer(escrow.address, escrowedTribeones, {
						from: owner,
					});
					await escrow.appendVestingEntry(
						account1,
						web3.utils.toBN(now + twelveWeeks),
						escrowedTribeones,
						{
							from: owner,
						}
					);

					// Issue
					const maxIssuable = await tribeone.maxIssuableTribes(account1);
					await tribeone.issueTribes(maxIssuable, { from: account1 });

					// Compare
					const collaterisationRatio = await tribeone.collateralisationRatio(account1);
					const expectedCollaterisationRatio = divideDecimal(
						maxIssuable,
						multiplyDecimal(transferredTribeones, snx2usdRate)
					);
					assert.bnEqual(collaterisationRatio, expectedCollaterisationRatio);
				});

				it("should include escrowed reward tribeone when calculating a user's collateralisation ratio", async () => {
					const snx2usdRate = await exchangeRates.rateForCurrency(wHAKA);
					const transferredTribeones = toUnit('60000');
					await tribeone.transfer(account1, transferredTribeones, {
						from: owner,
					});

					const escrowedTribeones = toUnit('30000');
					await tribeone.transfer(rewardEscrowV2.address, escrowedTribeones, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedTribeones, duration, {
						from: account6,
					});

					// Issue
					const maxIssuable = await tribeone.maxIssuableTribes(account1);
					await tribeone.issueTribes(maxIssuable, { from: account1 });

					// Compare
					const collaterisationRatio = await tribeone.collateralisationRatio(account1);
					const expectedCollaterisationRatio = divideDecimal(
						maxIssuable,
						multiplyDecimal(escrowedTribeones.add(transferredTribeones), snx2usdRate)
					);
					assert.bnEqual(collaterisationRatio, expectedCollaterisationRatio);
				});

				it('should permit user to issue hUSD debt with only escrowed wHAKA as collateral (no wHAKA in wallet)', async () => {
					// ensure collateral of account1 is empty
					let collateral = await tribeone.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, 0);

					// ensure account1 has no wHAKA balance
					const snxBalance = await tribeone.balanceOf(account1);
					assert.bnEqual(snxBalance, 0);

					// Append escrow amount to account1
					const escrowedAmount = toUnit('15000');
					await tribeone.transfer(rewardEscrowV2.address, escrowedAmount, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedAmount, duration, {
						from: account6,
					});

					// collateral should include escrowed amount
					collateral = await tribeone.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, escrowedAmount);

					// Issue max tribes. (300 hUSD)
					await tribeone.issueMaxTribes({ from: account1 });

					// There should be 300 hUSD of value for account1
					assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('300'));
				});

				it('should permit user to issue hUSD debt with only reward escrow as collateral (no wHAKA in wallet)', async () => {
					// ensure collateral of account1 is empty
					let collateral = await tribeone.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, 0);

					// ensure account1 has no wHAKA balance
					const snxBalance = await tribeone.balanceOf(account1);
					assert.bnEqual(snxBalance, 0);

					// Append escrow amount to account1
					const escrowedAmount = toUnit('15000');
					await tribeone.transfer(rewardEscrowV2.address, escrowedAmount, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedAmount, duration, {
						from: account6,
					});

					// collateral now should include escrowed amount
					collateral = await tribeone.collateral(account1, { from: account1 });
					assert.bnEqual(collateral, escrowedAmount);

					// Issue max tribes. (300 hUSD)
					await tribeone.issueMaxTribes({ from: account1 });

					// There should be 300 hUSD of value for account1
					assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('300'));
				});

				it("should permit anyone checking another user's collateral", async () => {
					const amount = toUnit('60000');
					await tribeone.transfer(account1, amount, { from: owner });
					const collateral = await tribeone.collateral(account1, { from: account2 });
					assert.bnEqual(collateral, amount);
				});

				it("should not include escrowed tribeone when checking a user's collateral", async () => {
					const oneWeek = 60 * 60 * 24 * 7;
					const twelveWeeks = oneWeek * 12;
					const now = await currentTime();
					const escrowedAmount = toUnit('15000');
					await tribeone.transfer(escrow.address, escrowedAmount, {
						from: owner,
					});
					await escrow.appendVestingEntry(
						account1,
						web3.utils.toBN(now + twelveWeeks),
						escrowedAmount,
						{
							from: owner,
						}
					);

					const amount = toUnit('60000');
					await tribeone.transfer(account1, amount, { from: owner });
					const collateral = await tribeone.collateral(account1, { from: account2 });
					assert.bnEqual(collateral, amount);
				});

				it("should include escrowed reward tribeone when checking a user's collateral", async () => {
					const escrowedAmount = toUnit('15000');
					await tribeone.transfer(rewardEscrowV2.address, escrowedAmount, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedAmount, duration, {
						from: account6,
					});
					const amount = toUnit('60000');
					await tribeone.transfer(account1, amount, { from: owner });
					const collateral = await tribeone.collateral(account1, { from: account2 });
					assert.bnEqual(collateral, amount.add(escrowedAmount));
				});

				it("should calculate a user's remaining issuable tribes", async () => {
					const transferredTribeones = toUnit('60000');
					await tribeone.transfer(account1, transferredTribeones, {
						from: owner,
					});

					// Issue
					const maxIssuable = await tribeone.maxIssuableTribes(account1);
					const issued = maxIssuable.div(web3.utils.toBN(3));
					await tribeone.issueTribes(issued, { from: account1 });
					const expectedRemaining = maxIssuable.sub(issued);
					const issuableTribes = await issuer.remainingIssuableTribes(account1);
					assert.bnEqual(expectedRemaining, issuableTribes.maxIssuable);
				});

				it("should correctly calculate a user's max issuable tribes with escrowed tribeone", async () => {
					const snx2usdRate = await exchangeRates.rateForCurrency(wHAKA);
					const transferredTribeones = toUnit('60000');
					await tribeone.transfer(account1, transferredTribeones, {
						from: owner,
					});

					// Setup escrow
					const escrowedTribeones = toUnit('30000');
					await tribeone.transfer(rewardEscrowV2.address, escrowedTribeones, {
						from: owner,
					});
					await rewardEscrowV2.appendVestingEntry(account1, escrowedTribeones, duration, {
						from: account6,
					});

					const maxIssuable = await tribeone.maxIssuableTribes(account1);
					// await tribeone.issueTribes(maxIssuable, { from: account1 });

					// Compare
					const issuanceRatio = await systemSettings.issuanceRatio();
					const expectedMaxIssuable = multiplyDecimal(
						multiplyDecimal(escrowedTribeones.add(transferredTribeones), snx2usdRate),
						issuanceRatio
					);
					assert.bnEqual(maxIssuable, expectedMaxIssuable);
				});
			});

			describe('issue and burn on behalf', async () => {
				const authoriser = account1;
				const delegate = account2;

				beforeEach(async () => {
					// Assign the authoriser wHAKA
					await tribeone.transfer(authoriser, toUnit('20000'), {
						from: owner,
					});
					await updateAggregatorRates(exchangeRates, circuitBreaker, [wHAKA], [toUnit('1')]);
					await updateDebtMonitors();
				});
				describe('when not approved it should revert on', async () => {
					it('issueMaxTribesOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: tribeone.issueMaxTribesOnBehalf,
							args: [authoriser],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
					it('issueTribesOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: tribeone.issueTribesOnBehalf,
							args: [authoriser, toUnit('1')],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
					it('burnTribesOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: tribeone.burnTribesOnBehalf,
							args: [authoriser, toUnit('1')],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
					it('burnTribesToTargetOnBehalf', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: tribeone.burnTribesToTargetOnBehalf,
							args: [authoriser],
							accounts,
							reason: 'Not approved to act on behalf',
						});
					});
				});

				['System', 'Issuance'].forEach(section => {
					describe(`when ${section} is suspended`, () => {
						beforeEach(async () => {
							// ensure user has tribes to burn
							await tribeone.issueTribes(toUnit('1000'), { from: authoriser });
							await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });
							await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });
							await setStatus({ owner, systemStatus, section, suspend: true });
						});
						it('then calling issueTribesOnBehalf() reverts', async () => {
							await assert.revert(
								tribeone.issueTribesOnBehalf(authoriser, toUnit('1'), { from: delegate }),
								'Operation prohibited'
							);
						});
						it('and calling issueMaxTribesOnBehalf() reverts', async () => {
							await assert.revert(
								tribeone.issueMaxTribesOnBehalf(authoriser, { from: delegate }),
								'Operation prohibited'
							);
						});
						it('and calling burnTribesOnBehalf() reverts', async () => {
							await assert.revert(
								tribeone.burnTribesOnBehalf(authoriser, toUnit('1'), { from: delegate }),
								'Operation prohibited'
							);
						});
						it('and calling burnTribesToTargetOnBehalf() reverts', async () => {
							await assert.revert(
								tribeone.burnTribesToTargetOnBehalf(authoriser, { from: delegate }),
								'Operation prohibited'
							);
						});

						describe(`when ${section} is resumed`, () => {
							beforeEach(async () => {
								await setStatus({ owner, systemStatus, section, suspend: false });
							});
							it('then calling issueTribesOnBehalf() succeeds', async () => {
								await tribeone.issueTribesOnBehalf(authoriser, toUnit('1'), { from: delegate });
							});
							it('and calling issueMaxTribesOnBehalf() succeeds', async () => {
								await tribeone.issueMaxTribesOnBehalf(authoriser, { from: delegate });
							});
							it('and calling burnTribesOnBehalf() succeeds', async () => {
								await tribeone.burnTribesOnBehalf(authoriser, toUnit('1'), { from: delegate });
							});
							it('and calling burnTribesToTargetOnBehalf() succeeds', async () => {
								// need the user to be undercollaterized for this to succeed
								await updateAggregatorRates(
									exchangeRates,
									circuitBreaker,
									[wHAKA],
									[toUnit('0.001')]
								);
								await updateDebtMonitors();

								await tribeone.burnTribesToTargetOnBehalf(authoriser, { from: delegate });
							});
						});
					});
				});

				it('should approveIssueOnBehalf for account1', async () => {
					await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });
					const result = await delegateApprovals.canIssueFor(authoriser, delegate);

					assert.isTrue(result);
				});
				it('should approveBurnOnBehalf for account1', async () => {
					await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });
					const result = await delegateApprovals.canBurnFor(authoriser, delegate);

					assert.isTrue(result);
				});
				it('should approveIssueOnBehalf and IssueMaxTribes', async () => {
					await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });

					const hUSDBalanceBefore = await hUSDContract.balanceOf(account1);
					const issuableTribes = await tribeone.maxIssuableTribes(account1);

					await tribeone.issueMaxTribesOnBehalf(authoriser, { from: delegate });
					const hUSDBalanceAfter = await hUSDContract.balanceOf(account1);
					assert.bnEqual(hUSDBalanceAfter, hUSDBalanceBefore.add(issuableTribes));
				});
				it('should approveIssueOnBehalf and IssueTribes', async () => {
					await delegateApprovals.approveIssueOnBehalf(delegate, { from: authoriser });

					await tribeone.issueTribesOnBehalf(authoriser, toUnit('100'), { from: delegate });

					const hUSDBalance = await hUSDContract.balanceOf(account1);
					assert.bnEqual(hUSDBalance, toUnit('100'));
				});
				it('should approveBurnOnBehalf and BurnTribes', async () => {
					await tribeone.issueMaxTribes({ from: authoriser });
					await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });

					const hUSDBalanceBefore = await hUSDContract.balanceOf(account1);
					await tribeone.burnTribesOnBehalf(authoriser, hUSDBalanceBefore, { from: delegate });

					const hUSDBalance = await hUSDContract.balanceOf(account1);
					assert.bnEqual(hUSDBalance, toUnit('0'));
				});
				it('should approveBurnOnBehalf and burnTribesToTarget', async () => {
					await tribeone.issueMaxTribes({ from: authoriser });
					await updateAggregatorRates(exchangeRates, circuitBreaker, [wHAKA], [toUnit('0.01')]);
					await updateDebtMonitors();

					await delegateApprovals.approveBurnOnBehalf(delegate, { from: authoriser });

					await tribeone.burnTribesToTargetOnBehalf(authoriser, { from: delegate });

					const hUSDBalanceAfter = await hUSDContract.balanceOf(account1);
					assert.bnEqual(hUSDBalanceAfter, toUnit('40'));
				});
			});

			describe('when Wrapper is set', async () => {
				it('should have zero totalIssuedTribes', async () => {
					assert.bnEqual(
						await tribeone.totalIssuedTribes(hUSD),
						await tribeone.totalIssuedTribesExcludeOtherCollateral(hUSD)
					);
				});
				describe('depositing WETH on the Wrapper to issue hETH', async () => {
					let etherWrapper;
					beforeEach(async () => {
						// mock etherWrapper
						etherWrapper = await MockEtherWrapper.new({ from: owner });
						await addressResolver.importAddresses(
							[toBytes32('EtherWrapper')],
							[etherWrapper.address],
							{ from: owner }
						);

						// ensure DebtCache has the latest EtherWrapper
						await debtCache.rebuildCache();
					});

					it('should be able to exclude hETH issued by EtherWrapper from totalIssuedTribes', async () => {
						const totalSupplyBefore = await tribeone.totalIssuedTribes(hETH);

						const amount = toUnit('10');

						await etherWrapper.setTotalIssuedTribes(amount, { from: account1 });

						// totalSupply of tribes should exclude Wrapper issued hETH
						assert.bnEqual(
							totalSupplyBefore,
							await tribeone.totalIssuedTribesExcludeOtherCollateral(hETH)
						);

						// totalIssuedTribes after includes amount issued
						const { rate } = await exchangeRates.rateAndInvalid(hETH);
						assert.bnEqual(
							await tribeone.totalIssuedTribes(hETH),
							totalSupplyBefore.add(divideDecimalRound(amount, rate))
						);
					});
				});
			});

			describe('burnForRedemption', () => {
				it('only allowed by the tribe redeemer', async () => {
					await onlyGivenAddressCanInvoke({
						fnc: issuer.burnForRedemption,
						args: [ZERO_ADDRESS, ZERO_ADDRESS, toUnit('1')],
						accounts,
						reason: 'Only TribeRedeemer',
					});
				});
				describe('when a user has 100 hETH', () => {
					beforeEach(async () => {
						await hETHContract.issue(account1, toUnit('100'));
						await updateDebtMonitors();
					});
					describe('when burnForRedemption is invoked on the user for 75 hETH', () => {
						beforeEach(async () => {
							// spoof the tribe redeemer
							await addressResolver.importAddresses([toBytes32('TribeRedeemer')], [account6], {
								from: owner,
							});
							// rebuild the resolver cache in the issuer
							await issuer.rebuildCache();
							// now invoke the burn
							await issuer.burnForRedemption(await hETHContract.proxy(), account1, toUnit('75'), {
								from: account6,
							});
						});
						it('then the user has 25 hETH remaining', async () => {
							assert.bnEqual(await hETHContract.balanceOf(account1), toUnit('25'));
						});
					});
				});
			});

			describe('debt shares integration', async () => {
				let aggTDR;

				beforeEach(async () => {
					// create aggregator mocks
					aggTDR = await MockAggregator.new({ from: owner });

					// Set debt ratio oracle value
					await aggTDR.setLatestAnswer(toPreciseUnit('0.4'), await currentTime());

					await addressResolver.importAddresses(
						[toBytes32('ext:AggregatorDebtRatio')],
						[aggTDR.address],
						{
							from: owner,
						}
					);

					// rebuild the resolver cache in the issuer
					await issuer.rebuildCache();

					// issue some initial debt to work with
					await tribeone.issueTribes(toUnit('100'), { from: owner });

					// send test user some snx so he can mint too
					await tribeone.transfer(account1, toUnit('1000000'), { from: owner });
				});

				it('mints the correct number of debt shares', async () => {
					// Issue tribes
					await tribeone.issueTribes(toUnit('100'), { from: account1 });
					assert.bnEqual(await debtShares.balanceOf(account1), toUnit('250')); // = 100 / 0.4
					assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('100'));
				});

				it('burns the correct number of debt shares', async () => {
					await tribeone.issueTribes(toUnit('300'), { from: account1 });
					await tribeone.burnTribes(toUnit('30'), { from: account1 });
					assert.bnEqual(await debtShares.balanceOf(account1), toUnit('675')); // = 270 / 0.4
					assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('270'));
				});

				describe('when debt ratio changes', () => {
					beforeEach(async () => {
						// user mints and gets 300 husd / 0.4 = 750 debt shares
						await tribeone.issueTribes(toUnit('300'), { from: account1 });

						// Debt ratio oracle value is updated
						await aggTDR.setLatestAnswer(toPreciseUnit('0.6'), await currentTime());
					});

					it('has adjusted debt', async () => {
						assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('450')); // = 750 sds * 0.6
					});

					it('mints at adjusted rate', async () => {
						await tribeone.issueTribes(toUnit('300'), { from: account1 });

						assert.bnEqual(await debtShares.balanceOf(account1), toUnit('1250')); // = 750 (shares from before) + 300 / 0.6
						assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('750')); // = 450 (hUSD from before ) + 300
					});
				});

				describe('issued tribes aggregator', async () => {
					let aggTIS;
					beforeEach(async () => {
						// create aggregator mocks
						aggTIS = await MockAggregator.new({ from: owner });

						// Set issued tribes oracle value
						await aggTIS.setLatestAnswer(toPreciseUnit('1234123412341234'), await currentTime());

						await addressResolver.importAddresses(
							[toBytes32('ext:AggregatorIssuedTribes')],
							[aggTIS.address],
							{
								from: owner,
							}
						);
					});

					it('has no effect on mint or burn', async () => {
						// user mints and gets 300 husd  / 0.4 = 750 debt shares
						await tribeone.issueTribes(toUnit('300'), { from: account1 });
						// user burns 30 husd / 0.4 = 75 debt shares
						await tribeone.burnTribes(toUnit('30'), { from: account1 });
						assert.bnEqual(await debtShares.balanceOf(account1), toUnit('675')); // 750 - 75 sds
						assert.bnEqual(await tribeone.debtBalanceOf(account1, hUSD), toUnit('270')); // 300 - 30 husd
					});
				});
			});

			describe('upgradeCollateralShort', () => {
				const collateralShortMock = account1;
				const wrongCollateralShort = account2;

				beforeEach(async () => {
					// Import CollateralShortLegacy address (mocked)
					await addressResolver.importAddresses(
						[toBytes32('CollateralShortLegacy')],
						[collateralShortMock],
						{
							from: owner,
						}
					);

					await exchanger.rebuildCache();
				});

				describe('basic protection', () => {
					it('should not allow an invalid address for the CollateralShortLegacy', async () => {
						await assert.revert(
							issuer.upgradeCollateralShort(wrongCollateralShort, toUnit(0.1), { from: owner }),
							'wrong address'
						);
					});

					it('should not allow 0 as amount', async () => {
						await assert.revert(
							issuer.upgradeCollateralShort(collateralShortMock, toUnit(0), {
								from: owner,
							}),
							'cannot burn 0 tribes'
						);
					});
				});

				describe('migrates balance', () => {
					let beforeCurrentDebt, beforeHUSDBalance;
					const amountToBurn = toUnit(10);

					beforeEach(async () => {
						// Give some wHAKA to collateralShortMock
						await tribeone.transfer(collateralShortMock, toUnit('1000'), { from: owner });

						// issue max hUSD
						const maxTribes = await tribeone.maxIssuableTribes(collateralShortMock);
						await tribeone.issueTribes(maxTribes, { from: collateralShortMock });

						// get before* values
						beforeHUSDBalance = await hUSDContract.balanceOf(collateralShortMock);
						const currentDebt = await debtCache.currentDebt();
						beforeCurrentDebt = currentDebt['0'];

						// call upgradeCollateralShort
						await issuer.upgradeCollateralShort(collateralShortMock, amountToBurn, {
							from: owner,
						});
					});

					it('burns tribes', async () => {
						assert.bnEqual(
							await hUSDContract.balanceOf(collateralShortMock),
							beforeHUSDBalance.sub(amountToBurn)
						);
					});

					it('reduces currentDebt', async () => {
						const currentDebt = await debtCache.currentDebt();
						assert.bnEqual(currentDebt['0'], beforeCurrentDebt.sub(amountToBurn));
					});
				});
			});

			describe('modifyDebtSharesForMigration', () => {
				const debtMigratorOnEthereumMock = account1;
				const debtMigratorOnOptimismMock = account2;
				const fakeMigrator = account3;

				beforeEach(async () => {
					// Import mocked debt migrator addresses to the resolver
					await addressResolver.importAddresses(
						[toBytes32('DebtMigratorOnEthereum'), toBytes32('DebtMigratorOnOptimism')],
						[debtMigratorOnEthereumMock, debtMigratorOnOptimismMock],
						{
							from: owner,
						}
					);

					await issuer.rebuildCache();
				});

				describe('basic protection', () => {
					it('should not allow an invalid migrator address', async () => {
						await assert.revert(
							issuer.modifyDebtSharesForMigration(owner, toUnit(1), { from: fakeMigrator }),
							'only trusted migrators'
						);
					});

					it('should not allow both debt migrators to be set on the same layer', async () => {
						await assert.revert(
							issuer.modifyDebtSharesForMigration(account1, toUnit(100), {
								from: debtMigratorOnEthereumMock,
							}),
							'one migrator must be 0x0'
						);
					});
				});

				describe('modifying debt share balance for migration', () => {
					describe('on L1', () => {
						let beforeDebtShareBalance;
						const amountToBurn = toUnit(10);

						beforeEach(async () => {
							// Make sure one of the debt migrators is 0x
							// (in this case it's the Optimism migrator)
							await addressResolver.importAddresses(
								[toBytes32('DebtMigratorOnOptimism')],
								[ZERO_ADDRESS],
								{
									from: owner,
								}
							);
							await issuer.rebuildCache();

							// Give some wHAKA to the mock migrator
							await tribeone.transfer(debtMigratorOnEthereumMock, toUnit('1000'), { from: owner });

							// issue max hUSD
							const maxTribes = await tribeone.maxIssuableTribes(debtMigratorOnEthereumMock);
							await tribeone.issueTribes(maxTribes, { from: debtMigratorOnEthereumMock });

							// get before value
							beforeDebtShareBalance = await debtShares.balanceOf(debtMigratorOnEthereumMock);

							// call modify debt shares
							await issuer.modifyDebtSharesForMigration(debtMigratorOnEthereumMock, amountToBurn, {
								from: debtMigratorOnEthereumMock,
							});
						});

						it('burns the expected amount of debt shares', async () => {
							assert.bnEqual(
								await debtShares.balanceOf(debtMigratorOnEthereumMock),
								beforeDebtShareBalance.sub(amountToBurn)
							);
						});
					});
					describe('on L2', () => {
						let beforeDebtShareBalance;
						const amountToMint = toUnit(10);

						beforeEach(async () => {
							// Make sure one of the debt migrators is 0x
							// (in this case it's the Ethereum migrator)
							await addressResolver.importAddresses(
								[toBytes32('DebtMigratorOnEthereum')],
								[ZERO_ADDRESS],
								{
									from: owner,
								}
							);
							await issuer.rebuildCache();

							// get before value
							beforeDebtShareBalance = await debtShares.balanceOf(debtMigratorOnOptimismMock);

							// call modify debt shares
							await issuer.modifyDebtSharesForMigration(debtMigratorOnOptimismMock, amountToMint, {
								from: debtMigratorOnOptimismMock,
							});
						});

						it('mints the expected amount of debt shares', async () => {
							assert.bnEqual(
								await debtShares.balanceOf(debtMigratorOnOptimismMock),
								beforeDebtShareBalance.add(amountToMint)
							);
						});
					});
				});
			});
		});
	});
});
