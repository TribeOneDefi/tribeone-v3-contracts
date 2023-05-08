'use strict';

const { artifacts, contract, web3, ethers } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { setupAllContracts, setupContract } = require('./setup');

const {
	currentTime,
	multiplyDecimal,
	divideDecimal,
	toUnit,
	toBN,
	fastForward,
} = require('../utils')();

const {
	onlyGivenAddressCanInvoke,
	ensureOnlyExpectedMutativeFunctions,
	setStatus,
	updateAggregatorRates,
} = require('./helpers');

const {
	toBytes32,
	ZERO_ADDRESS,
	defaults: {
		ISSUANCE_RATIO,
		LIQUIDATION_DELAY,
		LIQUIDATION_RATIO,
		LIQUIDATION_ESCROW_DURATION,
		HAKA_LIQUIDATION_PENALTY,
		SELF_LIQUIDATION_PENALTY,
		FLAG_REWARD,
		LIQUIDATE_REWARD,
	},
} = require('../..');

const MockExchanger = artifacts.require('MockExchanger');
const FlexibleStorage = artifacts.require('FlexibleStorage');

contract('Liquidator', accounts => {
	const [hUSD, HAKA] = ['hUSD', 'HAKA'].map(toBytes32);
	const [deployerAccount, owner, , account1, alice, bob, carol, david] = accounts;
	const week = 3600 * 24 * 7;

	let addressResolver,
		exchangeRates,
		circuitBreaker,
		liquidator,
		liquidatorRewards,
		tribeone,
		tribeoneProxy,
		tribeoneDebtShare,
		synthsUSD,
		rewardEscrowV2,
		systemSettings,
		systemStatus,
		debtCache,
		legacyTribeoneEscrow,
		issuer;

	// run this once before all tests to prepare our environment, snapshots on beforeEach will take
	// care of resetting to this state
	before(async () => {
		({
			AddressResolver: addressResolver,
			ExchangeRates: exchangeRates,
			CircuitBreaker: circuitBreaker,
			Liquidator: liquidator,
			LiquidatorRewards: liquidatorRewards,
			Tribeone: tribeone,
			ProxyERC20Tribeone: tribeoneProxy,
			TribeoneDebtShare: tribeoneDebtShare,
			RewardEscrowV2: rewardEscrowV2,
			SynthsUSD: synthsUSD,
			SystemSettings: systemSettings,
			SystemStatus: systemStatus,
			DebtCache: debtCache,
			Issuer: issuer,
			TribeoneEscrow: legacyTribeoneEscrow,
		} = await setupAllContracts({
			accounts,
			synths: ['hUSD'],
			contracts: [
				'AddressResolver',
				'ExchangeRates',
				'CircuitBreaker',
				'Exchanger', // required for Tribeone to check if exchanger().hasWaitingPeriodOrSettlementOwing
				'FeePool',
				'DebtCache',
				'Issuer',
				'Liquidator',
				'LiquidatorRewards',
				'SystemStatus', // test system status controls
				'SystemSettings',
				'Tribeone',
				'TribeoneDebtShare',
				'CollateralManager',
				'RewardEscrowV2', // required for Issuer._collateral() to load balances
				'TribeoneEscrow', // needed to check that it's not considered for rewards
			],
		}));

		// remove burn lock to allow burning
		await systemSettings.setMinimumStakeTime(0, { from: owner });

		// approve creating escrow entries from owner
		await tribeone.approve(rewardEscrowV2.address, ethers.constants.MaxUint256, { from: owner });

		// use implementation ABI on the proxy address to simplify calling
		tribeone = await artifacts.require('Tribeone').at(tribeoneProxy.address);
	});

	addSnapshotBeforeRestoreAfterEach();

	const fastForwardAndUpdateRates = async seconds => {
		await fastForward(seconds);
		await updateRatesWithDefaults();
	};

	const updateRatesWithDefaults = async () => {
		await updateHAKAPrice('6');
	};

	const updateHAKAPrice = async rate => {
		await updateAggregatorRates(exchangeRates, circuitBreaker, [HAKA], [rate].map(toUnit));
		await debtCache.takeDebtSnapshot();
	};

	const setLiquidHAKABalance = async (account, amount) => {
		// burn debt
		await tribeone.burnSynths(await synthsUSD.balanceOf(account), { from: account });
		// remove all haka
		await tribeone.transfer(owner, await tribeone.balanceOf(account), {
			from: account,
		});
		// send HAKA from owner
		await tribeone.transfer(account, amount, { from: owner });
	};

	const createEscrowEntries = async (account, entryAmount, numEntries) => {
		for (let i = 0; i < numEntries; i++) {
			await rewardEscrowV2.createEscrowEntry(account, entryAmount, 1, { from: owner });
		}
		return entryAmount.mul(toBN(numEntries));
	};

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: liquidator.abi,
			ignoreParents: ['Owned', 'MixinResolver'],
			expected: [
				'flagAccountForLiquidation',
				'removeAccountInLiquidation',
				'checkAndRemoveAccountInLiquidation',
			],
		});
	});

	it('should set constructor params on deployment', async () => {
		const instance = await setupContract({
			contract: 'Liquidator',
			accounts,
			skipPostDeploy: true,
			args: [account1, addressResolver.address],
		});

		assert.equal(await instance.owner(), account1);
		assert.equal(await instance.resolver(), addressResolver.address);
	});

	describe('Default settings', () => {
		it('liquidation (issuance) ratio', async () => {
			const liquidationRatio = await liquidator.liquidationRatio();
			assert.bnEqual(liquidationRatio, LIQUIDATION_RATIO);
		});
		it('liquidation collateral ratio is inverted ratio', async () => {
			const liquidationCollateralRatio = await liquidator.liquidationCollateralRatio();
			assert.bnClose(liquidationCollateralRatio, divideDecimal(toUnit('1'), LIQUIDATION_RATIO));
		});
		it('liquidation escrow duration', async () => {
			const liquidationEscrowDuration = await liquidator.liquidationEscrowDuration();
			assert.bnEqual(liquidationEscrowDuration, LIQUIDATION_ESCROW_DURATION);
		});
		it('liquidation penalty ', async () => {
			const liquidationPenalty = await liquidator.liquidationPenalty();
			assert.bnEqual(liquidationPenalty, HAKA_LIQUIDATION_PENALTY);
		});
		it('self liquidation penalty ', async () => {
			const selfLiquidationPenalty = await liquidator.selfLiquidationPenalty();
			assert.bnEqual(selfLiquidationPenalty, SELF_LIQUIDATION_PENALTY);
		});
		it('liquidation delay', async () => {
			const liquidationDelay = await liquidator.liquidationDelay();
			assert.bnEqual(liquidationDelay, LIQUIDATION_DELAY);
		});
		it('issuance ratio is correctly configured as a default', async () => {
			assert.bnEqual(await liquidator.issuanceRatio(), ISSUANCE_RATIO);
		});
		it('flag reward', async () => {
			const flagReward = await liquidator.flagReward();
			assert.bnEqual(flagReward, FLAG_REWARD);
		});
		it('liquidate reward', async () => {
			const liquidateReward = await liquidator.liquidateReward();
			assert.bnEqual(liquidateReward, LIQUIDATE_REWARD);
		});
	});

	describe('with issuanceRatio of 0.125', () => {
		beforeEach(async () => {
			// Set issuanceRatio to 800%
			const issuanceRatio800 = toUnit('0.125');
			await systemSettings.setIssuanceRatio(issuanceRatio800, { from: owner });

			await updateRatesWithDefaults();
		});
		describe('system staleness checks', () => {
			describe('when HAKA is stale', () => {
				beforeEach(async () => {
					const rateStalePeriod = await exchangeRates.rateStalePeriod();

					// fast forward until rates are stale
					await fastForward(rateStalePeriod + 1);
				});
				it('when flagAccountForLiquidation() is invoked, it reverts for rate stale', async () => {
					await assert.revert(
						liquidator.flagAccountForLiquidation(alice, { from: owner }),
						'Rate invalid or not a synth'
					);
				});
				it('when checkAndRemoveAccountInLiquidation() is invoked, it reverts for rate stale', async () => {
					await assert.revert(
						liquidator.checkAndRemoveAccountInLiquidation(alice, { from: owner }),
						'Rate invalid or not a synth'
					);
				});
			});
			describe('when the system is suspended', () => {
				beforeEach(async () => {
					await setStatus({ owner, systemStatus, section: 'System', suspend: true });
				});
				it('when liquidateDelinquentAccount() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						tribeone.liquidateDelinquentAccount(alice, { from: owner }),
						'Operation prohibited'
					);
				});
				it('when liquidateSelf() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(tribeone.liquidateSelf({ from: owner }), 'Operation prohibited');
				});
				it('when checkAndRemoveAccountInLiquidation() is invoked, it reverts with operation prohibited', async () => {
					await assert.revert(
						liquidator.checkAndRemoveAccountInLiquidation(alice, { from: owner }),
						'Operation prohibited'
					);
				});
			});
			describe('when the liquidation default params not set', () => {
				let storage;
				beforeEach(async () => {
					storage = await FlexibleStorage.new(addressResolver.address, {
						from: deployerAccount,
					});

					// replace FlexibleStorage in resolver
					await addressResolver.importAddresses(
						['FlexibleStorage'].map(toBytes32),
						[storage.address],
						{
							from: owner,
						}
					);

					await liquidator.rebuildCache();
					await systemSettings.rebuildCache();
				});
				it('when flagAccountForLiquidation() is invoked, it reverts with liquidation ratio not set', async () => {
					await assert.revert(
						liquidator.flagAccountForLiquidation(alice, { from: owner }),
						'Liquidation ratio not set'
					);
				});
				describe('when the liquidationRatio is set', () => {
					beforeEach(async () => {
						// await systemSettings.setIssuanceRatio(ISSUANCE_RATIO, { from: owner });
						await systemSettings.setLiquidationRatio(LIQUIDATION_RATIO, { from: owner });
					});
					it('when flagAccountForLiquidation() is invoked, it reverts with liquidation delay not set', async () => {
						await assert.revert(
							liquidator.flagAccountForLiquidation(alice, { from: owner }),
							'Liquidation delay not set'
						);
					});
				});
			});
		});
		describe('when the v3 legacy market is set', () => {
			beforeEach(async () => {
				// Set the LegacyMarket address to something non-zero
				await addressResolver.importAddresses(['LegacyMarket'].map(toBytes32), [owner], {
					from: owner,
				});

				// now have Liquidator resync its cache
				await liquidator.rebuildCache();
			});
			it('when flagAccountForLiquidation() is invoked, it reverts with must liquidate using V3', async () => {
				await assert.revert(
					liquidator.flagAccountForLiquidation(alice, { from: owner }),
					'Must liquidate using V3'
				);
			});
		});
		describe('protected methods', () => {
			describe('only internal contracts can call', () => {
				beforeEach(async () => {
					// Overwrite Issuer address to the owner to allow us to invoke removeAccInLiquidation
					await addressResolver.importAddresses(['Issuer'].map(toBytes32), [owner], {
						from: owner,
					});

					// now have Liquidator resync its cache
					await liquidator.rebuildCache();
				});
				it('removeAccountInLiquidation() can only be invoked by issuer', async () => {
					await onlyGivenAddressCanInvoke({
						fnc: liquidator.removeAccountInLiquidation,
						args: [alice],
						address: owner, // TODO: is this supposed to be issuer.address
						accounts,
						reason: 'Liquidator: Only the Issuer contract can perform this action',
					});
				});
			});
		});
		describe('calculateAmountToFixCollateral', () => {
			let ratio;
			let penalty;
			let collateralBefore;
			let debtBefore;
			describe('given target ratio of 800%, collateral of $600, debt of $300', () => {
				beforeEach(async () => {
					ratio = toUnit('0.125');
					collateralBefore = toUnit('600');
					debtBefore = toUnit('300');
					penalty = toUnit('0.1');
				});
				describe('given liquidation penalty is 10%', () => {
					it('calculates hUSD to fix ratio from 200%, with $600 HAKA collateral and $300 debt', async () => {
						const expectedAmount = toUnit('260.869565217391304347');

						// amount of debt to redeem to fix
						const susdToLiquidate = await liquidator.calculateAmountToFixCollateral(
							debtBefore,
							collateralBefore,
							penalty
						);

						assert.bnEqual(susdToLiquidate, expectedAmount);

						// check expected amount fixes c-ratio to 800%
						const debtAfter = debtBefore.sub(susdToLiquidate);
						const collateralAfterMinusPenalty = collateralBefore.sub(
							multiplyDecimal(susdToLiquidate, toUnit('1').add(penalty))
						);

						// c-ratio = debt / collateral
						const collateralRatio = divideDecimal(debtAfter, collateralAfterMinusPenalty);

						assert.bnEqual(collateralRatio, ratio);
					});
					it('calculates hUSD to fix ratio from 300%, with $600 HAKA collateral and $200 debt', async () => {
						debtBefore = toUnit('200');
						const expectedAmount = toUnit('144.927536231884057971');

						// amount of debt to redeem to fix
						const susdToLiquidate = await liquidator.calculateAmountToFixCollateral(
							debtBefore,
							collateralBefore,
							penalty
						);

						assert.bnEqual(susdToLiquidate, expectedAmount);

						// check expected amount fixes c-ratio to 800%
						const debtAfter = debtBefore.sub(susdToLiquidate);
						const collateralAfterMinusPenalty = collateralBefore.sub(
							multiplyDecimal(susdToLiquidate, toUnit('1').add(penalty))
						);

						// c-ratio = debt / collateral
						const collateralRatio = divideDecimal(debtAfter, collateralAfterMinusPenalty);

						assert.bnEqual(collateralRatio, ratio);
					});
				});
			});
		});
		describe('when Alice calls liquidateSelf', () => {
			let exchanger;
			describe('then do self liquidation checks', () => {
				beforeEach(async () => {
					exchanger = await MockExchanger.new(tribeone.address);
					await addressResolver.importAddresses(['Exchanger'].map(toBytes32), [exchanger.address], {
						from: owner,
					});
					await Promise.all([tribeone.rebuildCache(), issuer.rebuildCache()]);
				});
				it('when Alice is not is not open for self liquidation then revert', async () => {
					await assert.revert(tribeone.liquidateSelf({ from: alice }), 'Not open for liquidation');
				});
			});
			describe('when Alice is undercollateralized', () => {
				beforeEach(async () => {
					// wen HAKA 6 dolla
					await updateHAKAPrice('6');

					// Alice issues hUSD $600
					await tribeone.transfer(alice, toUnit('800'), { from: owner });
					await tribeone.issueMaxSynths({ from: alice });

					// Bob issues hUSD $6000
					await tribeone.transfer(bob, toUnit('8000'), { from: owner });
					await tribeone.issueMaxSynths({ from: bob });

					// Drop HAKA value to $1 (Collateral worth $800 after)
					await updateHAKAPrice('1');
				});
				it('and liquidation Collateral Ratio is 150%', async () => {
					assert.bnClose(await liquidator.liquidationCollateralRatio(), toUnit('1.5'));
				});
				it('and self liquidation penalty is 20%', async () => {
					assert.bnEqual(await liquidator.selfLiquidationPenalty(), SELF_LIQUIDATION_PENALTY);
				});
				describe('when Alice issuance ratio is fixed as HAKA price increases', () => {
					beforeEach(async () => {
						await updateHAKAPrice('6');

						const liquidationRatio = await liquidator.liquidationRatio();

						const ratio = await tribeone.collateralisationRatio(alice);
						const targetIssuanceRatio = await liquidator.issuanceRatio();

						// check Alice ratio is above liquidation ratio
						assert.isTrue(ratio.lt(liquidationRatio));

						// check Alice ratio is above or equal to target issuance ratio
						assert.isTrue(ratio.lte(targetIssuanceRatio));
					});
					it('then isLiquidationOpen returns false as ratio equal to target issuance ratio', async () => {
						assert.isFalse(await liquidator.isLiquidationOpen(alice, true));
					});
				});
				describe('given Alice issuance ratio is higher than the liquidation ratio', () => {
					let liquidationRatio;
					beforeEach(async () => {
						liquidationRatio = await liquidator.liquidationRatio();

						const ratio = await tribeone.collateralisationRatio(alice);
						const targetIssuanceRatio = await liquidator.issuanceRatio();

						// check Alice ratio is above or equal liquidation ratio
						assert.isTrue(ratio.gte(liquidationRatio));

						// check Alice ratio is above target issuance ratio
						assert.isTrue(ratio.gt(targetIssuanceRatio));
					});
					it('then isLiquidationOpen returns true', async () => {
						assert.isTrue(await liquidator.isLiquidationOpen(alice, true));
					});
				});
				describe('when Alice c-ratio is above the liquidation ratio and attempts to self liquidate', () => {
					beforeEach(async () => {
						await updateHAKAPrice('10');

						await assert.revert(
							tribeone.liquidateSelf({
								from: alice,
							}),
							'Not open for liquidation'
						);
					});
					it('then liquidationAmounts returns zeros', async () => {
						assert.deepEqual(await liquidator.liquidationAmounts(alice, true), [
							0,
							0,
							0,
							toUnit('600'),
						]);
					});
					it('then Alices account is not open for self liquidation', async () => {
						const isSelfLiquidationOpen = await liquidator.isLiquidationOpen(alice, true);
						assert.bnEqual(isSelfLiquidationOpen, false);
					});
					it('then Alice still has 800 HAKA', async () => {
						assert.bnEqual(await tribeone.collateral(alice), toUnit('800'));
					});
				});
				describe('given Alice has $600 Debt, $800 worth of HAKA Collateral and c-ratio at 133.33%', () => {
					describe('when Alice calls self liquidate', () => {
						let txn;
						let ratio;
						let penalty;
						let aliceDebtValueBefore;
						let aliceDebtShareBefore;
						let aliceCollateralBefore;
						let bobDebtValueBefore, bobRewardsBalanceBefore;
						let amountToFixRatio;
						beforeEach(async () => {
							// Given issuance ratio is 800%
							ratio = toUnit('0.125');

							// And self liquidation penalty is 20%
							penalty = toUnit('0.2');
							await systemSettings.setSelfLiquidationPenalty(penalty, { from: owner });

							// Record Alices state
							aliceCollateralBefore = await tribeone.collateral(alice);
							aliceDebtShareBefore = await tribeoneDebtShare.balanceOf(alice);
							aliceDebtValueBefore = await tribeone.debtBalanceOf(alice, hUSD);

							// Record Bobs state
							bobDebtValueBefore = await tribeone.debtBalanceOf(bob, hUSD);
							bobRewardsBalanceBefore = await liquidatorRewards.earned(bob);

							txn = await tribeone.liquidateSelf({
								from: alice,
							});
						});
						it('it succeeds and the ratio is fixed', async () => {
							const cratio = await tribeone.collateralisationRatio(alice);

							// check Alice ratio is above or equal to target issuance ratio
							assert.bnClose(ratio, cratio, toUnit('100000000000000000'));

							// check Alice has their debt share and collateral reduced
							assert.isTrue((await tribeoneDebtShare.balanceOf(alice)).lt(aliceDebtShareBefore));
							assert.isTrue((await tribeone.collateral(alice)).lt(aliceCollateralBefore));

							const expectedAmount = toUnit('588.235294117647058823');

							// amount of debt to redeem to fix
							amountToFixRatio = await liquidator.calculateAmountToFixCollateral(
								aliceDebtValueBefore,
								aliceCollateralBefore,
								penalty
							);

							assert.bnEqual(amountToFixRatio, expectedAmount);

							// check expected amount fixes c-ratio to 800%
							const debtAfter = aliceDebtValueBefore.sub(amountToFixRatio);
							const collateralAfterMinusPenalty = aliceCollateralBefore.sub(
								multiplyDecimal(amountToFixRatio, toUnit('1').add(penalty))
							);

							// c-ratio = debt / collateral
							const collateralRatio = divideDecimal(debtAfter, collateralAfterMinusPenalty);

							assert.bnEqual(collateralRatio, ratio);

							// Alice should not be open for liquidation anymore
							assert.isFalse(await liquidator.isLiquidationOpen(alice, false));

							// Check that the redeemed HAKA is sent to the LiquidatorRewards contract
							const logs = artifacts.require('Tribeone').decodeLogs(txn.receipt.rawLogs);
							assert.eventEqual(
								logs.find(log => log.event === 'AccountLiquidated'),
								'AccountLiquidated',
								{
									account: alice,
									hakaRedeemed: await tribeone.balanceOf(liquidatorRewards.address),
								}
							);

							// Make sure the other staker, Bob, gets the redeemed HAKA bonus.
							const bobDebtValueAfter = await tribeone.debtBalanceOf(bob, hUSD);
							const bobRewardsBalanceAfter = await liquidatorRewards.earned(bob);

							assert.bnGt(bobDebtValueAfter, bobDebtValueBefore);
							assert.bnGt(bobRewardsBalanceAfter, bobRewardsBalanceBefore);

							const debtValueDiff = bobDebtValueAfter.sub(bobDebtValueBefore);
							const rewardsDiff = bobRewardsBalanceAfter.sub(bobRewardsBalanceBefore);
							assert.bnGt(rewardsDiff, debtValueDiff);
						});
					});
				});
				describe('with some HAKA in escrow', () => {
					let escrowBalance;
					beforeEach(async () => {
						escrowBalance = await createEscrowEntries(alice, toUnit('1'), 100);
						// double check escrow
						assert.bnEqual(await rewardEscrowV2.balanceOf(alice), escrowBalance);
					});
					it('escrow balance is not used for self-liquidation', async () => {
						const hakaBalanceBefore = await tribeone.balanceOf(alice);
						const debtBefore = await tribeone.debtBalanceOf(alice, hUSD);
						const totalDebt = await tribeone.totalIssuedSynths(hUSD);
						// just above the liquidation ratio
						await updateHAKAPrice('1');
						await tribeone.liquidateSelf({ from: alice });
						// liquid haka is reduced
						const hakaBalanceAfter = await tribeone.balanceOf(alice);
						assert.bnLt(hakaBalanceAfter, hakaBalanceBefore);
						// escrow untouched
						assert.bnEqual(await rewardEscrowV2.balanceOf(alice), escrowBalance);
						// system debt is the same
						assert.bnEqual(await tribeone.totalIssuedSynths(hUSD), totalDebt);
						// debt shares forgiven matching the liquidated HAKA
						// redeemed = (liquidatedHaka * HAKAPrice / (1 + penalty))
						// debt is fewer shares (but of higher debt per share), by (total - redeemed / total) more debt per share
						const liquidatedHaka = hakaBalanceBefore.sub(hakaBalanceAfter);
						const redeemed = divideDecimal(liquidatedHaka, toUnit('1.2'));
						const shareMultiplier = divideDecimal(totalDebt, totalDebt.sub(redeemed));
						assert.bnClose(
							await tribeone.debtBalanceOf(alice, hUSD),
							multiplyDecimal(debtBefore.sub(redeemed), shareMultiplier),
							toUnit(0.001)
						);
					});
				});
				describe('with only escrowed HAKA', () => {
					let escrowBalanceBefore;
					beforeEach(async () => {
						await setLiquidHAKABalance(alice, 0);
						escrowBalanceBefore = await createEscrowEntries(alice, toUnit('1'), 100);

						// set up liquidation
						await updateHAKAPrice('6');
						await tribeone.issueMaxSynths({ from: alice });
						await updateHAKAPrice('1');
					});
					it('should revert with cannot self liquidate', async () => {
						// should have no liquida HAKA balance, only in escrow
						const hakaBalance = await tribeone.balanceOf(alice);
						const collateralBalance = await tribeone.collateral(alice);
						const escrowBalanceAfter = await rewardEscrowV2.balanceOf(alice);

						assert.bnEqual(hakaBalance, toUnit('0'));
						assert.bnEqual(collateralBalance, escrowBalanceBefore);
						assert.bnEqual(escrowBalanceAfter, escrowBalanceBefore);

						await assert.revert(tribeone.liquidateSelf({ from: alice }), 'cannot self liquidate');
					});
				});
			});
		});

		describe('when anyone calls liquidateDelinquentAccount on alice', () => {
			let exchanger;
			describe('then do liquidation checks', () => {
				beforeEach(async () => {
					exchanger = await MockExchanger.new(tribeone.address);
					await addressResolver.importAddresses(['Exchanger'].map(toBytes32), [exchanger.address], {
						from: owner,
					});
					await Promise.all([tribeone.rebuildCache(), issuer.rebuildCache()]);
				});
				it('when an account is not open for liquidation then revert', async () => {
					await assert.revert(
						tribeone.liquidateDelinquentAccount(alice, { from: bob }),
						'Not open for liquidation'
					);
				});
				it('then liquidationAmounts returns zeros', async () => {
					assert.deepEqual(await liquidator.liquidationAmounts(alice, false), [0, 0, 0, 0]);
				});
			});
			describe('when Alice is undercollateralized', () => {
				beforeEach(async () => {
					// wen HAKA 6 dolla
					await updateHAKAPrice('6');

					// Alice issues hUSD $600
					await tribeone.transfer(alice, toUnit('800'), { from: owner });
					await tribeone.issueMaxSynths({ from: alice });

					// Bob issues hUSD $6000
					await tribeone.transfer(bob, toUnit('8000'), { from: owner });
					await tribeone.issueMaxSynths({ from: bob });

					// Drop HAKA value to $1 (Collateral worth $800 after)
					await updateHAKAPrice('1');
				});
				it('and liquidation Collateral Ratio is 150%', async () => {
					assert.bnClose(await liquidator.liquidationCollateralRatio(), toUnit('1.5'));
				});
				it('and liquidation penalty is 10%', async () => {
					assert.bnEqual(await liquidator.liquidationPenalty(), HAKA_LIQUIDATION_PENALTY);
				});
				it('and liquidation delay is 3 days', async () => {
					assert.bnEqual(await liquidator.liquidationDelay(), LIQUIDATION_DELAY);
				});
				describe('when Alice has not been flagged for liquidation', () => {
					it('and Alice calls checkAndRemoveAccountInLiquidation then it reverts', async () => {
						await assert.revert(
							liquidator.checkAndRemoveAccountInLiquidation(alice, {
								from: alice,
							}),
							'Account has no liquidation set'
						);
					});
					it('then isLiquidationDeadlinePassed returns false as no liquidation set', async () => {
						assert.isFalse(await liquidator.isLiquidationDeadlinePassed(alice));
					});
				});
				it('if not enough HAKA to cover flag reward flagAccountForLiquidation reverts', async () => {
					await setLiquidHAKABalance(alice, toUnit(1));
					await updateHAKAPrice('6');
					await tribeone.issueMaxSynths({ from: alice });
					await updateHAKAPrice('1');
					// cannot flag the account
					await assert.revert(
						liquidator.flagAccountForLiquidation(alice, { from: bob }),
						'not enough HAKA for rewards'
					);
				});
				describe('when Bob flags Alice for liquidation', () => {
					let flagForLiquidationTransaction;
					let timeOfTransaction;
					beforeEach(async () => {
						timeOfTransaction = await currentTime();
						flagForLiquidationTransaction = await liquidator.flagAccountForLiquidation(alice, {
							from: bob,
						});
					});
					it('then sets a deadline liquidation delay of 2 weeks', async () => {
						const liquidationDeadline = await liquidator.getLiquidationDeadlineForAccount(alice);
						assert.isTrue(liquidationDeadline.gt(0));
						assert.isTrue(liquidationDeadline.gt(timeOfTransaction));
						assert.isTrue(liquidationDeadline.gt(timeOfTransaction + week * 2));
					});
					it('then emits an event accountFlaggedForLiquidation', async () => {
						const liquidationDeadline = await liquidator.getLiquidationDeadlineForAccount(alice);
						assert.eventEqual(flagForLiquidationTransaction, 'AccountFlaggedForLiquidation', {
							account: alice,
							deadline: liquidationDeadline,
						});
					});
					describe('when deadline has passed and Alice issuance ratio is fixed as HAKA price increases', () => {
						beforeEach(async () => {
							const delay = await liquidator.liquidationDelay();

							// fast forward to after deadline
							await fastForward(delay + 100);

							await updateHAKAPrice(toUnit('6'));

							const liquidationRatio = await liquidator.liquidationRatio();

							const ratio = await tribeone.collateralisationRatio(alice);
							const targetIssuanceRatio = await liquidator.issuanceRatio();

							// check Alice ratio is below liquidation ratio
							assert.isTrue(ratio.lt(liquidationRatio));

							// check Alice ratio is below or equal to target issuance ratio
							assert.isTrue(ratio.lte(targetIssuanceRatio));
						});
						it('then isLiquidationDeadlinePassed returns true', async () => {
							assert.isTrue(await liquidator.isLiquidationDeadlinePassed(alice));
						});
						it('then isLiquidationOpen returns false as ratio equal to target issuance ratio', async () => {
							assert.isFalse(await liquidator.isLiquidationOpen(alice, false));
						});
					});
					describe('given Alice issuance ratio is higher than the liquidation ratio', () => {
						let liquidationRatio;
						beforeEach(async () => {
							liquidationRatio = await liquidator.liquidationRatio();

							const ratio = await tribeone.collateralisationRatio(alice);
							const targetIssuanceRatio = await liquidator.issuanceRatio();

							// check Alice ratio is above or equal liquidation ratio
							assert.isTrue(ratio.gte(liquidationRatio));

							// check Alice ratio is above target issuance ratio
							assert.isTrue(ratio.gt(targetIssuanceRatio));
						});
						describe('when the liquidation deadline has not passed', () => {
							it('then isLiquidationOpen returns false as deadline not passed', async () => {
								assert.isFalse(await liquidator.isLiquidationOpen(alice, false));
							});
							it('then isLiquidationDeadlinePassed returns false', async () => {
								assert.isFalse(await liquidator.isLiquidationDeadlinePassed(alice));
							});
						});
						describe('fast forward 2 weeks, when the liquidation deadline has passed', () => {
							beforeEach(async () => {
								const delay = await liquidator.liquidationDelay();

								await fastForward(delay + 100);
							});
							it('then isLiquidationDeadlinePassed returns true', async () => {
								assert.isTrue(await liquidator.isLiquidationDeadlinePassed(alice));
							});
							it('then isLiquidationOpen returns true', async () => {
								assert.isTrue(await liquidator.isLiquidationOpen(alice, false));
							});
						});

						it('if not enough HAKA to cover flag reward isLiquidationOpen returns false', async () => {
							await setLiquidHAKABalance(alice, toUnit(1));
							await updateHAKAPrice('6');
							await tribeone.issueMaxSynths({ from: alice });
							await updateHAKAPrice('1');
							// should be false
							assert.isFalse(await liquidator.isLiquidationOpen(alice, false));
						});

						it('ignores TribeoneEscrow balance', async () => {
							await setLiquidHAKABalance(alice, 1);
							const escrowedAmount = toUnit(1000);
							await tribeone.transfer(legacyTribeoneEscrow.address, escrowedAmount, {
								from: owner,
							});
							await legacyTribeoneEscrow.appendVestingEntry(
								alice,
								toBN(await currentTime()).add(toBN(1000)),
								escrowedAmount,
								{
									from: owner,
								}
							);
							// check it's NOT counted towards collateral
							assert.bnEqual(await issuer.collateral(alice), 1);
							// cause bad c-ratio
							await updateHAKAPrice('1000');
							await tribeone.issueMaxSynths({ from: alice });
							await updateHAKAPrice('0.1');
							// should be false
							assert.isFalse(await liquidator.isLiquidationOpen(alice, false));
							// cannot flag the account
							await assert.revert(
								liquidator.flagAccountForLiquidation(alice, { from: bob }),
								'not enough HAKA for rewards'
							);
						});
					});
					describe('when Bob or anyone else tries to flag Alice address for liquidation again', () => {
						it('then it fails for Bob as Alices address is already flagged', async () => {
							await assert.revert(
								liquidator.flagAccountForLiquidation(alice, {
									from: bob,
								}),
								'Account already flagged for liquidation'
							);
						});
						it('then it fails for Carol Baskin as Alices address is already flagged', async () => {
							await assert.revert(
								liquidator.flagAccountForLiquidation(alice, {
									from: carol,
								}),
								'Account already flagged for liquidation'
							);
						});
					});
					describe('when the price of HAKA increases', () => {
						let removeFlagTransaction;
						beforeEach(async () => {
							await updateHAKAPrice('6');
						});
						describe('when Alice calls checkAndRemoveAccountInLiquidation', () => {
							beforeEach(async () => {
								removeFlagTransaction = await liquidator.checkAndRemoveAccountInLiquidation(alice, {
									from: alice,
								});
							});
							it('then Alice liquidation entry is removed', async () => {
								const deadline = await liquidator.getLiquidationDeadlineForAccount(alice);
								assert.bnEqual(deadline, 0);
							});
							it('then Alices account is not open for liquidation', async () => {
								const isForcedLiquidationOpen = await liquidator.isLiquidationOpen(alice, false);
								assert.bnEqual(isForcedLiquidationOpen, false);
							});
							it('then events AccountRemovedFromLiquidation are emitted', async () => {
								assert.eventEqual(removeFlagTransaction, 'AccountRemovedFromLiquidation', {
									account: alice,
								});
							});
						});
					});
					describe('given the liquidation deadline has passed ', () => {
						beforeEach(async () => {
							await fastForwardAndUpdateRates(week * 2.1);
						});
						describe('when Alice c-ratio is above the liquidation Ratio and Bob liquidates alice', () => {
							beforeEach(async () => {
								await updateHAKAPrice('10');

								// Bob Liquidates Alice
								await assert.revert(
									tribeone.liquidateDelinquentAccount(alice, {
										from: bob,
									}),
									'Not open for liquidation'
								);
							});
							it('then Alice liquidation entry remains', async () => {
								const deadline = await liquidator.getLiquidationDeadlineForAccount(alice);
								assert.isTrue(deadline > 0);
							});
							it('then Alices account is not open for liquidation', async () => {
								const isForcedLiquidationOpen = await liquidator.isLiquidationOpen(alice, false);
								assert.bnEqual(isForcedLiquidationOpen, false);
							});
							it('then Alice still has 600 SDS', async () => {
								assert.bnEqual(await tribeoneDebtShare.balanceOf(alice), toUnit('600'));
							});
							it('then Alice still has 800 HAKA', async () => {
								assert.bnEqual(await tribeone.collateral(alice), toUnit('800'));
							});
						});

						describe('when Alice burnSynthsToTarget to fix her c-ratio ', () => {
							let burnTransaction;
							beforeEach(async () => {
								await updateHAKAPrice('1');
								burnTransaction = await tribeone.burnSynthsToTarget({ from: alice });
							});
							it('then AccountRemovedFromLiquidation event is emitted', async () => {
								const logs = artifacts
									.require('Liquidator')
									.decodeLogs(burnTransaction.receipt.rawLogs);
								assert.eventEqual(
									logs.find(log => log.event === 'AccountRemovedFromLiquidation'),
									'AccountRemovedFromLiquidation',
									{
										account: alice,
									}
								);
							});
							it('then Alice liquidation entry is removed', async () => {
								const deadline = await liquidator.getLiquidationDeadlineForAccount(alice);
								assert.bnEqual(deadline, 0);
							});
							it('then Alices account is not open for liquidation', async () => {
								const isForcedLiquidationOpen = await liquidator.isLiquidationOpen(alice, false);
								assert.bnEqual(isForcedLiquidationOpen, false);
							});
						});
						describe('when Alice burnSynths and her c-ratio is still below issuance ratio', () => {
							let aliceDebtBalance;
							let amountToBurn;
							beforeEach(async () => {
								await updateHAKAPrice('1');
								aliceDebtBalance = await tribeoneDebtShare.balanceOf(alice);
								amountToBurn = toUnit('10');
								await tribeone.burnSynths(amountToBurn, { from: alice });
							});
							it('then alice debt balance is less amountToBurn', async () => {
								assert.bnEqual(
									await tribeoneDebtShare.balanceOf(alice),
									aliceDebtBalance.sub(amountToBurn)
								);
							});
							it('then Alice liquidation entry is still there', async () => {
								const deadline = await liquidator.getLiquidationDeadlineForAccount(alice);
								assert.isTrue(deadline > 0);
							});
							it('then Alices account is still open for liquidation', async () => {
								const isForcedLiquidationOpen = await liquidator.isLiquidationOpen(alice, false);
								assert.isTrue(isForcedLiquidationOpen);
							});
						});
						describe('when Alice burnSynths and her c-ratio is above issuance ratio', () => {
							let aliceDebtBalance;
							let amountToBurn;
							beforeEach(async () => {
								await updateHAKAPrice('1');
								aliceDebtBalance = await tribeoneDebtShare.balanceOf(alice);

								const maxIssuableSynths = await tribeone.maxIssuableSynths(alice);
								amountToBurn = aliceDebtBalance.sub(maxIssuableSynths).abs();

								await tribeone.burnSynths(amountToBurn, { from: alice });
							});
							it('then alice debt balance is less amountToBurn', async () => {
								assert.bnEqual(
									await tribeoneDebtShare.balanceOf(alice),
									aliceDebtBalance.sub(amountToBurn)
								);
							});
							it('then Alice liquidation entry is removed', async () => {
								const deadline = await liquidator.getLiquidationDeadlineForAccount(alice);
								assert.bnEqual(deadline, 0);
							});
							it('then Alices account is not open for liquidation', async () => {
								const isForcedLiquidationOpen = await liquidator.isLiquidationOpen(alice, false);
								assert.bnEqual(isForcedLiquidationOpen, false);
							});
						});
						describe('when Alice burns all her debt to fix her c-ratio', () => {
							let aliceDebtBalance;
							let burnTransaction;
							beforeEach(async () => {
								await updateHAKAPrice('1');

								aliceDebtBalance = await tribeoneDebtShare.balanceOf(alice);

								burnTransaction = await tribeone.burnSynths(aliceDebtBalance, { from: alice });
							});
							it('then alice has no more debt', async () => {
								assert.bnEqual(toUnit(0), await tribeoneDebtShare.balanceOf(alice));
							});
							it('then AccountRemovedFromLiquidation event is emitted', async () => {
								const logs = artifacts
									.require('Liquidator')
									.decodeLogs(burnTransaction.receipt.rawLogs);
								assert.eventEqual(
									logs.find(log => log.event === 'AccountRemovedFromLiquidation'),
									'AccountRemovedFromLiquidation',
									{
										account: alice,
									}
								);
							});
							it('then Alice liquidation entry is removed', async () => {
								const deadline = await liquidator.getLiquidationDeadlineForAccount(alice);
								assert.bnEqual(deadline, 0);
							});
							it('then Alices account is not open for liquidation', async () => {
								const isForcedLiquidationOpen = await liquidator.isLiquidationOpen(alice, false);
								assert.bnEqual(isForcedLiquidationOpen, false);
							});
						});
						describe('when Alice does not fix her c-ratio ', () => {
							beforeEach(async () => {
								await updateHAKAPrice('1');
							});
							it('then isLiquidationOpen returns true for Alice', async () => {
								const isForcedLiquidationOpen = await liquidator.isLiquidationOpen(alice, false);
								assert.equal(isForcedLiquidationOpen, true);
							});
							describe('when Alice calls checkAndRemoveAccountInLiquidation', () => {
								beforeEach(async () => {
									await liquidator.checkAndRemoveAccountInLiquidation(alice, {
										from: alice,
									});
								});
								it('then Alices account is still open for liquidation', async () => {
									const isForcedLiquidationOpen = await liquidator.isLiquidationOpen(alice, false);
									assert.bnEqual(isForcedLiquidationOpen, true);
								});
								it('then Alice liquidation deadline still exists', async () => {
									const deadline = await liquidator.getLiquidationDeadlineForAccount(alice);
									assert.notEqual(deadline, 0);
								});
								it('then Alice liquidation caller still exists', async () => {
									const caller = await liquidator.getLiquidationCallerForAccount(alice);
									assert.notEqual(caller, ZERO_ADDRESS);
								});
							});
							describe('given Alice has $600 Debt, $800 worth of HAKA Collateral and c-ratio at 133.33%', () => {
								describe('when bob calls liquidateDelinquentAccount on Alice', () => {
									let txn;
									let ratio;
									let penalty;
									let aliceDebtShareBefore;
									let aliceDebtValueBefore;
									let aliceCollateralBefore;
									let bobHakaBalanceBefore;
									let amountToFixRatio;
									beforeEach(async () => {
										// Given issuance ratio is 800%
										ratio = toUnit('0.125');

										// And liquidation penalty is 30%
										penalty = toUnit('0.3');
										await systemSettings.setHakaLiquidationPenalty(penalty, { from: owner });

										// And liquidation penalty is 20%. (This is used only for Collateral, included here to demonstrate it has no effect on HAKA liquidations.)
										await systemSettings.setLiquidationPenalty(toUnit('0.2'), {
											from: owner,
										});

										// Record Alices state
										aliceCollateralBefore = await tribeone.collateral(alice);
										aliceDebtShareBefore = await tribeoneDebtShare.balanceOf(alice);
										aliceDebtValueBefore = await tribeone.debtBalanceOf(alice, hUSD);

										// Record Bobs state
										bobHakaBalanceBefore = await tribeone.balanceOf(bob);

										// Should be able to liquidate and fix c-ratio
										txn = await tribeone.liquidateDelinquentAccount(alice, {
											from: bob,
										});
									});
									it('then Bob can liquidate Alice once fixing the c-ratio', async () => {
										const cratio = await tribeone.collateralisationRatio(alice);

										// check Alice ratio is above or equal to target issuance ratio
										assert.bnClose(ratio, cratio, toUnit('100000000000000000'));

										// check Alice has their debt share and collateral reduced
										assert.isTrue(
											(await tribeoneDebtShare.balanceOf(alice)).lt(aliceDebtShareBefore)
										);
										assert.isTrue((await tribeone.collateral(alice)).lt(aliceCollateralBefore));

										const expectedAmount = toUnit('597.014925373134328358');

										// amount of debt to redeem to fix
										amountToFixRatio = await liquidator.calculateAmountToFixCollateral(
											aliceDebtValueBefore,
											aliceCollateralBefore,
											penalty
										);

										assert.bnEqual(amountToFixRatio, expectedAmount);

										// check expected amount fixes c-ratio to 800%
										const debtAfter = aliceDebtValueBefore.sub(amountToFixRatio);
										const collateralAfterMinusPenalty = aliceCollateralBefore.sub(
											multiplyDecimal(amountToFixRatio, toUnit('1').add(penalty))
										);

										// c-ratio = debt / collateral
										const collateralRatio = divideDecimal(debtAfter, collateralAfterMinusPenalty);

										assert.bnEqual(collateralRatio, ratio);

										// Alice should not be open for liquidation anymore
										assert.isFalse(await liquidator.isLiquidationOpen(alice, false));

										// Alice should have liquidation entry removed
										assert.bnEqual(await liquidator.getLiquidationDeadlineForAccount(alice), 0);

										const logs = artifacts.require('Liquidator').decodeLogs(txn.receipt.rawLogs);
										assert.eventEqual(
											logs.find(log => log.event === 'AccountRemovedFromLiquidation'),
											'AccountRemovedFromLiquidation',
											{
												account: alice,
											}
										);

										// then the liquidation rewards are properly distributed to bob
										const flagReward = await liquidator.flagReward();
										const liquidateReward = await liquidator.liquidateReward();
										const caller = await liquidator.getLiquidationCallerForAccount(alice);

										assert.bnEqual(
											await tribeone.balanceOf(caller),
											bobHakaBalanceBefore.add(flagReward).add(liquidateReward)
										);
									});
								});
							});
							describe('with only escrowed HAKA', () => {
								let escrowBefore;
								let flagReward;
								let liquidateReward;
								let sumOfRewards;
								beforeEach(async () => {
									// setup rewards
									await systemSettings.setFlagReward(toUnit('1'), { from: owner });
									await systemSettings.setLiquidateReward(toUnit('2'), { from: owner });
									flagReward = await liquidator.flagReward();
									liquidateReward = await liquidator.liquidateReward();
									sumOfRewards = flagReward.add(liquidateReward);
									assert.bnEqual(await systemSettings.hakaLiquidationPenalty(), toUnit('0.3')); // 30% penalty
									assert.bnEqual(
										await systemSettings.liquidationRatio(),
										toUnit('0.666666666666666666')
									); // 150% liquidation ratio

									// set up only escrow, no liquid HAKA
									await setLiquidHAKABalance(alice, 0);
									escrowBefore = await createEscrowEntries(alice, toUnit('1'), 100);

									// set up liquidation
									await updateHAKAPrice('8');
									assert.bnEqual(await systemSettings.issuanceRatio(), toUnit('0.125')); // 800% target c-ratio

									await tribeone.issueSynths(toUnit('100'), { from: alice }); // 800% c-ratio
									await updateHAKAPrice('1.4'); // price dumps
									assert.bnClose(
										await tribeone.collateralisationRatio(alice),
										toUnit('0.7142857143'),
										toUnit(0.001)
									); // 140% c-ratio
									await liquidator.flagAccountForLiquidation(alice, { from: bob });
									await fastForward((await liquidator.liquidationDelay()) + 100);
									await updateHAKAPrice('1.4');
								});
								it('getFirstNonZeroEscrowIndex returns first entry as non zero', async () => {
									assert.bnEqual(await tribeone.getFirstNonZeroEscrowIndex(alice), 0);
								});
								it('escrow balance is used for liquidation (partial)', async () => {
									const debtBefore = await tribeone.debtBalanceOf(alice, hUSD);
									const debtSharesBefore = await tribeoneDebtShare.balanceOf(alice);
									const totalDebtSharesBefore = await tribeoneDebtShare.totalSupply();
									const totalDebt = await tribeone.totalIssuedSynths(hUSD);
									const viewResult = await liquidator.liquidationAmounts(alice, false);

									// calculate debt per debt share BEFORE liquidation
									const debtInfo = await issuer.allNetworksDebtInfo();
									assert.bnEqual(debtInfo.debt, totalDebt);
									assert.bnEqual(debtInfo.sharesSupply, totalDebtSharesBefore);
									assert.isFalse(debtInfo.isStale, false);

									// LIQUIDATION
									await tribeone.liquidateDelinquentAccount(alice, { from: bob });

									// no liquid balance added
									assert.bnEqual(await tribeone.balanceOf(alice), 0);

									// system debt is the same
									assert.bnEqual(await tribeone.totalIssuedSynths(hUSD), totalDebt);
									const escrowAfter = await rewardEscrowV2.balanceOf(alice);
									const debtAfter = await tribeone.debtBalanceOf(alice, hUSD);

									// first non zero entry is equal to the amount of 100 - escrow remaining
									const firstNonZero = await tribeone.getFirstNonZeroEscrowIndex(alice);
									assert.bnEqual(firstNonZero, toBN(100).sub(escrowAfter.div(toUnit(1))));

									// get delta of debt shares
									const debtSharesAfter = await tribeoneDebtShare.balanceOf(alice);
									const debtDelta =
										(debtSharesBefore - debtSharesAfter) * (totalDebt / totalDebtSharesBefore);
									assert.bnLt(
										toBN(debtDelta)
											.sub(viewResult.debtToRemove)
											.abs(),
										toBN(1e5)
									);

									// manually re-calculate the c-ratio which is:
									// collateral after minus earned() after
									// divided by
									// debtBefore minus debtToRemove
									// should be very close to 800% c-ratio
									const collateralAfter = await tribeone.collateral(alice);
									const earnedAfter = await liquidatorRewards.earned(alice);
									const dividend = collateralAfter.sub(earnedAfter);
									const divisor = debtBefore.sub(viewResult.debtToRemove);
									const res = toBN(dividend)
										.mul(toUnit('1.4')) // dividend * price of HAKA ($1.40)
										.div(toBN(divisor));
									assert.bnClose(res, toUnit('8'), 100); // 800% c-ratio

									// Note: it won't be exact in these tests because there are only a few stakers
									// and they get a sizeable amount of rewards as a result of their own liquidation.
									assert.bnClose(
										await tribeone.collateralisationRatio(alice),
										toUnit('0.125'),
										toUnit(0.1)
									); // 800% c-ratio

									// they have less collateral and less debt
									assert.bnLt(escrowAfter, escrowBefore);
									assert.bnLt(debtAfter, debtBefore);

									// check view results
									assert.bnEqual(viewResult.initialDebtBalance, toUnit('100'));
									assert.bnEqual(
										viewResult.totalRedeemed,
										escrowBefore.sub(escrowAfter).sub(sumOfRewards)
									);
									assert.bnEqual(viewResult.escrowToLiquidate, escrowBefore.sub(escrowAfter));
									assert.bnClose(
										viewResult.debtToRemove,
										toUnit('100').sub(debtAfter),
										toUnit(0.1)
									);
									// check result of view after liquidation
									assert.deepEqual(await liquidator.liquidationAmounts(alice, false), [
										0,
										0,
										0,
										debtAfter,
									]);
								});
								it('escrow balance is used for liquidation (full)', async () => {
									// penalty leaves no HAKA
									await updateHAKAPrice('0.1');
									const totalDebt = await tribeone.totalIssuedSynths(hUSD);
									const viewResult = await liquidator.liquidationAmounts(alice, false);
									await tribeone.liquidateDelinquentAccount(alice, { from: bob });
									// no liquid balance added
									assert.bnEqual(await tribeone.balanceOf(alice), 0);
									// system debt is the same
									assert.bnEqual(await tribeone.totalIssuedSynths(hUSD), totalDebt);
									const escrowAfter = await rewardEscrowV2.balanceOf(alice);
									const debtAfter = await tribeone.debtBalanceOf(alice, hUSD);
									// escrow is mostly removed
									assert.bnEqual(escrowAfter, 0);
									assert.bnEqual(debtAfter, 0);
									// check view results
									assert.bnEqual(viewResult.initialDebtBalance, toUnit('100'));
									assert.bnEqual(viewResult.totalRedeemed, escrowBefore.sub(sumOfRewards));
									assert.bnEqual(viewResult.escrowToLiquidate, escrowBefore);
									assert.bnClose(viewResult.debtToRemove, toUnit('100'), toUnit(0.01));
									// check result of view after liquidation
									assert.deepEqual(await liquidator.liquidationAmounts(alice, false), [0, 0, 0, 0]);
								});
								it('liquidateDelinquentAccountEscrowIndex reverts if index is too high and not enough is revoked', async () => {
									await assert.revert(
										tribeone.liquidateDelinquentAccountEscrowIndex(alice, 10, { from: bob }),
										'entries sum less than target'
									);
								});
								it('liquidateDelinquentAccountEscrowIndex revokes only after the index provided', async () => {
									const debtBefore = await tribeone.debtBalanceOf(alice, hUSD);
									const totalDebt = await tribeone.totalIssuedSynths(hUSD);
									const viewResult = await liquidator.liquidationAmounts(alice, false);
									await tribeone.liquidateDelinquentAccountEscrowIndex(alice, 2, { from: bob });
									// check first two entries
									const firstEntryId = await rewardEscrowV2.accountVestingEntryIDs(alice, 0);
									const secondEntryId = await rewardEscrowV2.accountVestingEntryIDs(alice, 1);
									assert.bnEqual(
										(await rewardEscrowV2.vestingSchedules(alice, firstEntryId)).escrowAmount,
										toUnit(1)
									);
									assert.bnEqual(
										(await rewardEscrowV2.vestingSchedules(alice, secondEntryId)).escrowAmount,
										toUnit(1)
									);
									// check the rest of the amounts
									// no liquid balance added
									assert.bnEqual(await tribeone.balanceOf(alice), 0);
									// system debt is the same
									assert.bnEqual(await tribeone.totalIssuedSynths(hUSD), totalDebt);
									const escrowAfter = await rewardEscrowV2.balanceOf(alice);
									const debtAfter = await tribeone.debtBalanceOf(alice, hUSD);

									// they have less collateral and less debt
									assert.bnLt(escrowAfter, escrowBefore);
									assert.bnLt(debtAfter, debtBefore);

									// check view results
									assert.bnEqual(viewResult.initialDebtBalance, toUnit('100'));
									assert.bnEqual(
										viewResult.totalRedeemed,
										escrowBefore.sub(escrowAfter).sub(sumOfRewards)
									);
									assert.bnEqual(viewResult.escrowToLiquidate, escrowBefore.sub(escrowAfter));
									assert.bnClose(
										viewResult.debtToRemove,
										toUnit('100').sub(debtAfter),
										toUnit(0.1)
									);
									// check result of view after liquidation
									assert.deepEqual(await liquidator.liquidationAmounts(alice, false), [
										0,
										0,
										0,
										debtAfter,
									]);
								});
							});
							describe('with some liquid and some escrowed', () => {
								const liquidBefore = toUnit('100');
								let escrowBefore;
								let flagReward;
								let liquidateReward;
								let sumOfRewards;
								beforeEach(async () => {
									flagReward = await liquidator.flagReward();
									liquidateReward = await liquidator.liquidateReward();
									sumOfRewards = flagReward.add(liquidateReward);

									await setLiquidHAKABalance(alice, liquidBefore);
									// set up liquidation
									await updateHAKAPrice('6');
									await tribeone.issueMaxSynths({ from: alice });
									await updateHAKAPrice('1');
									await liquidator.flagAccountForLiquidation(alice, { from: bob });
									await fastForward((await liquidator.liquidationDelay()) + 100);
									await updateHAKAPrice('1');
									// add some escrow (200 HAKA)
									// this is done now so that debt amount is determined by previous issueMaxSynths
									escrowBefore = await createEscrowEntries(alice, toUnit('1'), 200);
								});
								it('if liquid is enough, only liquid is used for liquidation', async () => {
									const totalDebt = await tribeone.totalIssuedSynths(hUSD);
									await tribeone.liquidateDelinquentAccount(alice, { from: bob });
									// new balances
									const liquidAfter = await tribeone.balanceOf(alice);
									const escrowAfter = await rewardEscrowV2.balanceOf(alice);
									// system debt is the same
									assert.bnEqual(await tribeone.totalIssuedSynths(hUSD), totalDebt);
									// liquid is reduced
									assert.bnLt(liquidAfter, liquidBefore);
									// escrow untouched
									assert.bnEqual(escrowAfter, escrowBefore);
								});
								it('if liquid is not enough, escrow is used for liquidation (full)', async () => {
									await updateHAKAPrice('0.25');
									const totalDebt = await tribeone.totalIssuedSynths(hUSD);
									await tribeone.liquidateDelinquentAccount(alice, { from: bob });
									// new balances
									const liquidAfter = await tribeone.balanceOf(alice);
									const escrowAfter = await rewardEscrowV2.balanceOf(alice);
									const debtAfter = await tribeone.debtBalanceOf(alice, hUSD);
									// system debt is the same
									assert.bnEqual(await tribeone.totalIssuedSynths(hUSD), totalDebt);
									// liquid zero
									assert.bnEqual(liquidAfter, 0);
									// escrow zero
									assert.bnEqual(escrowAfter, 0);
									// debt zero
									assert.bnEqual(debtAfter, 0);
								});
								it('if liquid is not enough, escrow is used for liquidation (partial)', async () => {
									await updateHAKAPrice('0.5');
									// add 90 more HAKA in escrow (collateral value as with HAKA @ 1, but with twice as much HAKA
									escrowBefore = escrowBefore.add(
										await createEscrowEntries(alice, toUnit('1'), 90)
									);
									const viewResult = await liquidator.liquidationAmounts(alice, false);
									await tribeone.liquidateDelinquentAccount(alice, { from: bob });
									// new balances
									const liquidAfter = await tribeone.balanceOf(alice);
									const escrowAfter = await rewardEscrowV2.balanceOf(alice);
									const debtAfter = await tribeone.debtBalanceOf(alice, hUSD);
									// liquid is zero
									assert.bnEqual(liquidAfter, 0);
									// escrow is reduced
									assert.bnLt(escrowAfter, escrowBefore);
									// some debt remains
									assert.bnGt(debtAfter, 0);
									// check view results
									assert.bnEqual(viewResult.initialDebtBalance, toUnit('75'));
									assert.bnEqual(
										viewResult.totalRedeemed,
										liquidBefore
											.add(escrowBefore)
											.sub(escrowAfter)
											.sub(sumOfRewards)
									);
									assert.bnEqual(viewResult.escrowToLiquidate, escrowBefore.sub(escrowAfter));
									assert.bnClose(
										viewResult.debtToRemove,
										toUnit('75').sub(debtAfter),
										toUnit('0.5')
									);
									// check result of view after liquidation
									assert.deepEqual(await liquidator.liquidationAmounts(alice, false), [
										0,
										0,
										0,
										debtAfter,
									]);
								});
							});
							describe('last escrow entry remainder is added as new entry', () => {
								const liquidBefore = toUnit('100');
								let escrowBefore;
								let numEntries;
								beforeEach(async () => {
									await setLiquidHAKABalance(alice, liquidBefore);
									// set up liquidation
									await updateHAKAPrice('6');
									await tribeone.issueMaxSynths({ from: alice });
									await updateHAKAPrice('1');
									await liquidator.flagAccountForLiquidation(alice, { from: bob });
									await fastForward((await liquidator.liquidationDelay()) + 100);
									await updateHAKAPrice('0.5');
									// add some escrow (200 HAKA) as one entry
									// this is done now so that debt amount is determined by previous issueMaxSynths
									escrowBefore = await createEscrowEntries(alice, toUnit('200'), 1);
									numEntries = await rewardEscrowV2.numVestingEntries(alice);
								});
								it('there is one new entry with remaining balance', async () => {
									await tribeone.liquidateDelinquentAccount(alice, { from: bob });
									// new balances
									const liquidAfter = await tribeone.balanceOf(alice);
									const escrowAfter = await rewardEscrowV2.balanceOf(alice);
									const debtAfter = await tribeone.debtBalanceOf(alice, hUSD);
									// liquid is zero
									assert.bnEqual(liquidAfter, 0);
									// some debt remains
									assert.bnGt(debtAfter, 0);
									// escrow is reduced
									assert.bnLt(escrowAfter, escrowBefore);
									// there's one more entry
									const newNumEntries = await rewardEscrowV2.numVestingEntries(alice);
									assert.bnEqual(newNumEntries, numEntries.add(toBN(1)));
									const lastEntryId = await rewardEscrowV2.accountVestingEntryIDs(
										alice,
										numEntries
									);
									// last entry has the whole remaining balance
									assert.bnEqual(
										(await rewardEscrowV2.getVestingEntry(alice, lastEntryId))[1],
										escrowAfter
									);
								});
							});
						});
					});
				});
			});
		});
		describe('Given Alice has HAKA and never issued any debt', () => {
			beforeEach(async () => {
				await tribeone.transfer(alice, toUnit('100'), { from: owner });
			});
			it('then she should not be able to be flagged for liquidation', async () => {
				await assert.revert(
					liquidator.flagAccountForLiquidation(alice),
					'Account issuance ratio is less than liquidation ratio'
				);
			});
			it('then liquidateDelinquentAccount fails', async () => {
				await assert.revert(
					tribeone.liquidateDelinquentAccount(alice),
					'Not open for liquidation'
				);
			});
			it('then liquidateSelf fails', async () => {
				await assert.revert(tribeone.liquidateSelf({ from: alice }), 'Not open for liquidation');
			});
		});
		describe('When Davids collateral value is less than debt issued + penalty', () => {
			let davidDebtBefore;
			let davidCollateralBefore;
			beforeEach(async () => {
				await updateHAKAPrice('6');

				// David issues hUSD $600
				await tribeone.transfer(david, toUnit('800'), { from: owner });
				await tribeone.issueMaxSynths({ from: david });

				// Drop HAKA value to $0.1 (Collateral worth $80)
				await updateHAKAPrice('0.1');
			});
			it('then his collateral ratio should be greater than 1 (more debt than collateral)', async () => {
				const cratio = await tribeone.collateralisationRatio(david);

				assert.isTrue(cratio.gt(toUnit('1')));

				davidDebtBefore = await tribeoneDebtShare.balanceOf(david);
				davidCollateralBefore = await tribeone.collateral(david);
				const collateralInUSD = await exchangeRates.effectiveValue(
					HAKA,
					davidCollateralBefore,
					hUSD
				);

				assert.isTrue(davidDebtBefore.gt(collateralInUSD));
			});
			it('then self liquidation reverts', async () => {
				await assert.revert(tribeone.liquidateSelf({ from: david }), 'Not open for liquidation');
			});
			describe('when Bob flags and tries to liquidate David', () => {
				beforeEach(async () => {
					// flag account for liquidation
					await liquidator.flagAccountForLiquidation(david, {
						from: bob,
					});

					// fastForward to after liquidation delay
					const liquidationDeadline = await liquidator.getLiquidationDeadlineForAccount(david);
					await fastForwardAndUpdateRates(liquidationDeadline + 1);

					// Drop HAKA value to $0.1 after update rates resets to default
					await updateHAKAPrice('0.1');

					// ensure Bob has enough hUSD
					await tribeone.transfer(bob, toUnit('100000'), {
						from: owner,
					});
					await tribeone.issueMaxSynths({ from: bob });
				});
				it('then david is openForLiquidation', async () => {
					assert.isTrue(await liquidator.isLiquidationOpen(david, false));
				});
				describe('when the HAKA rate is stale', () => {
					beforeEach(async () => {
						await fastForward((await exchangeRates.rateStalePeriod()).add(web3.utils.toBN('300')));
					});
					it('then liquidate reverts', async () => {
						await assert.revert(
							tribeone.liquidateDelinquentAccount(david, { from: bob }),
							'A synth or HAKA rate is invalid'
						);
					});
				});
				describe('when Bob liquidates all of davids collateral', async () => {
					beforeEach(async () => {
						await tribeone.liquidateDelinquentAccount(david, {
							from: bob,
						});
					});
					it('then David should have 0 transferable collateral', async () => {
						assert.bnEqual(await tribeone.balanceOf(david), toUnit('0'));
					});
					it('then David should still have debt owing', async () => {
						const davidDebt = await tribeoneDebtShare.balanceOf(david);
						assert.isTrue(davidDebt.gt(0));
					});
					it('then David wont be open for liquidation', async () => {
						assert.isFalse(await liquidator.isLiquidationOpen(david, false));
					});
					it('then David liquidation entry is removed', async () => {
						const deadline = await liquidator.getLiquidationDeadlineForAccount(david);
						assert.bnEqual(deadline, 0);
					});
				});
			});
		});
	});
});