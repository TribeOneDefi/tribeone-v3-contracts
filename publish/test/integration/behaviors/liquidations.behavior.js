const ethers = require('ethers');
const { toBytes32 } = require('../../../index');
const { assert } = require('../../contracts/common');
const { getRate, addAggregatorAndSetRate } = require('../utils/rates');
const { ensureBalance } = require('../utils/balances');
const { skipLiquidationDelay } = require('../utils/skip');

function itCanLiquidate({ ctx }) {
	describe('liquidating', () => {
		let user7, user8;
		let owner;
		let someUser;
		let liquidatedUser;
		let liquidatorUser;
		let flaggerUser;
		let exchangeRate;
		let Liquidator,
			LiquidatorRewards,
			RewardEscrowV2,
			Tribeone,
			TribeoneDebtShare,
			SystemSettings;

		before('target contracts and users', () => {
			({
				Liquidator,
				LiquidatorRewards,
				RewardEscrowV2,
				Tribeone,
				TribeoneDebtShare,
				SystemSettings,
			} = ctx.contracts);

			({ owner, someUser, liquidatedUser, flaggerUser, liquidatorUser, user7, user8 } = ctx.users);

			RewardEscrowV2 = RewardEscrowV2.connect(owner);
			SystemSettings = SystemSettings.connect(owner);
		});

		before('system settings are set', async () => {
			await SystemSettings.setIssuanceRatio(ethers.utils.parseEther('0.25')); // 400% c-ratio
			await SystemSettings.setLiquidationRatio(ethers.utils.parseEther('0.5')); // 200% c-ratio
			await SystemSettings.setHakaLiquidationPenalty(ethers.utils.parseEther('0.3')); // 30% penalty
			await SystemSettings.setSelfLiquidationPenalty(ethers.utils.parseEther('0.2')); // 20% penalty
			await SystemSettings.setFlagReward(ethers.utils.parseEther('1')); // 1 HAKA
			await SystemSettings.setLiquidateReward(ethers.utils.parseEther('2')); // 2 HAKA
		});

		before('ensure liquidatedUser has HAKA', async () => {
			await ensureBalance({
				ctx,
				symbol: 'HAKA',
				user: liquidatedUser,
				balance: ethers.utils.parseEther('800'),
			});
		});

		before('ensure someUser has HAKA', async () => {
			await ensureBalance({
				ctx,
				symbol: 'HAKA',
				user: someUser,
				balance: ethers.utils.parseEther('8000'),
			});
		});

		before('ensure user7 has HAKA', async () => {
			await ensureBalance({
				ctx,
				symbol: 'HAKA',
				user: user7,
				balance: ethers.utils.parseEther('800'),
			});
		});

		before('ensure user8 has HAKA', async () => {
			await ensureBalance({
				ctx,
				symbol: 'HAKA',
				user: user8,
				balance: ethers.utils.parseEther('800'),
			});
		});

		before('exchange rate is set', async () => {
			exchangeRate = await getRate({ ctx, symbol: 'HAKA' });
			await addAggregatorAndSetRate({
				ctx,
				currencyKey: toBytes32('HAKA'),
				rate: '6000000000000000000', // $6
			});
		});

		before('liquidatedUser stakes their HAKA', async () => {
			await Tribeone.connect(liquidatedUser).issueMaxSynths();
		});

		before('someUser stakes their HAKA', async () => {
			await Tribeone.connect(someUser).issueMaxSynths();
		});

		it('cannot be liquidated at this point', async () => {
			assert.equal(await Liquidator.isLiquidationOpen(liquidatedUser.address, false), false);
		});

		describe('getting marked and partially liquidated', () => {
			before('exchange rate changes to allow liquidation', async () => {
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('HAKA'),
					rate: '2500000000000000000', // $2.50
				});
			});

			before('liquidation is marked', async () => {
				await Liquidator.connect(flaggerUser).flagAccountForLiquidation(liquidatedUser.address);
			});

			after('restore exchange rate', async () => {
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('HAKA'),
					rate: exchangeRate.toString(),
				});
			});

			it('still not open for liquidation', async () => {
				assert.equal(await Liquidator.isLiquidationOpen(liquidatedUser.address, false), false);
			});

			it('deadline has not passed yet', async () => {
				assert.equal(await Liquidator.isLiquidationDeadlinePassed(liquidatedUser.address), false);
			});

			describe('when the liquidation delay passes', () => {
				before(async () => {
					await skipLiquidationDelay({ ctx });
				});

				describe('getting liquidated', () => {
					let tx;
					let beforeCRatio;
					let beforeDebtShares, beforeSharesSupply;
					let beforeFlagRewardCredittedHaka,
						beforeLiquidateRewardCredittedHaka,
						beforeRemainingRewardCredittedHaka;

					before('liquidatorUser calls liquidateDelinquentAccount', async () => {
						beforeDebtShares = await TribeoneDebtShare.balanceOf(liquidatedUser.address);
						beforeSharesSupply = await TribeoneDebtShare.totalSupply();
						beforeFlagRewardCredittedHaka = await Tribeone.balanceOf(flaggerUser.address);
						beforeLiquidateRewardCredittedHaka = await Tribeone.balanceOf(liquidatorUser.address);
						beforeRemainingRewardCredittedHaka = await Tribeone.balanceOf(
							LiquidatorRewards.address
						);

						beforeCRatio = await Tribeone.collateralisationRatio(liquidatedUser.address);

						tx = await Tribeone.connect(liquidatorUser).liquidateDelinquentAccount(
							liquidatedUser.address
						);

						const { gasUsed } = await tx.wait();
						console.log(
							`    liquidateDelinquentAccount() with no escrow entries gas used: ${Math.round(
								gasUsed / 1000
							).toString()}k`
						);
					});

					it('fixes the c-ratio of the partially liquidatedUser', async () => {
						const cratio = await Tribeone.collateralisationRatio(liquidatedUser.address);
						// Check that the ratio is repaired
						assert.bnLt(cratio, beforeCRatio);
					});

					it('reduces the total supply of debt shares by the amount of liquidated debt shares', async () => {
						const afterDebtShares = await TribeoneDebtShare.balanceOf(liquidatedUser.address);
						const liquidatedDebtShares = beforeDebtShares.sub(afterDebtShares);
						const afterSupply = beforeSharesSupply.sub(liquidatedDebtShares);

						assert.bnEqual(await TribeoneDebtShare.totalSupply(), afterSupply);
					});

					it('should remove the liquidation entry for the liquidatedUser', async () => {
						assert.isFalse(await Liquidator.isLiquidationOpen(liquidatedUser.address, false));
						assert.bnEqual(
							await Liquidator.getLiquidationDeadlineForAccount(liquidatedUser.address),
							0
						);
					});

					it('transfers the flag reward to flaggerUser', async () => {
						const flagReward = await Liquidator.flagReward();
						assert.bnEqual(
							await Tribeone.balanceOf(flaggerUser.address),
							beforeFlagRewardCredittedHaka.add(flagReward)
						);
					});

					it('transfers the liquidate reward to liquidatorUser', async () => {
						const liquidateReward = await Liquidator.liquidateReward();
						assert.bnEqual(
							await Tribeone.balanceOf(liquidatorUser.address),
							beforeLiquidateRewardCredittedHaka.add(liquidateReward)
						);
					});

					it('transfers the redeemed HAKA to LiquidatorRewards', async () => {
						const { events } = await tx.wait();
						const liqEvent = events.find(l => l.event === 'AccountLiquidated');
						const hakaRedeemed = liqEvent.args.hakaRedeemed;
						assert.bnEqual(
							await Tribeone.balanceOf(LiquidatorRewards.address),
							beforeRemainingRewardCredittedHaka.add(hakaRedeemed)
						);
					});

					it('should allow someUser to claim their share of the liquidation rewards', async () => {
						const earnedReward = await LiquidatorRewards.earned(someUser.address);

						const tx = await LiquidatorRewards.connect(someUser).getReward(someUser.address);

						const { events } = await tx.wait();

						const event = events.find(l => l.event === 'RewardPaid');
						const payee = event.args.user;
						const reward = event.args.reward;

						assert.equal(payee, someUser.address);
						assert.bnEqual(reward, earnedReward);

						const earnedRewardAfterClaiming = await LiquidatorRewards.earned(someUser.address);
						assert.bnEqual(earnedRewardAfterClaiming, '0');
					});
				});
			});
		});

		describe('getting marked and completely liquidated', () => {
			before('exchange rate is set', async () => {
				exchangeRate = await getRate({ ctx, symbol: 'HAKA' });
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('HAKA'),
					rate: '6000000000000000000', // $6
				});
			});

			before('user7 stakes their HAKA', async () => {
				await Tribeone.connect(user7).issueMaxSynths();
			});

			before('exchange rate changes to allow liquidation', async () => {
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('HAKA'),
					rate: '1000000000000000000', // $1.00
				});
			});

			before('liquidation is marked', async () => {
				await Liquidator.connect(flaggerUser).flagAccountForLiquidation(user7.address);
			});

			after('restore exchange rate', async () => {
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('HAKA'),
					rate: exchangeRate.toString(),
				});
			});

			it('still not open for liquidation', async () => {
				assert.equal(await Liquidator.isLiquidationOpen(user7.address, false), false);
			});

			it('deadline has not passed yet', async () => {
				assert.equal(await Liquidator.isLiquidationDeadlinePassed(user7.address), false);
			});

			describe('when the liquidation delay passes', () => {
				before(async () => {
					await skipLiquidationDelay({ ctx });
				});

				describe('getting liquidated', () => {
					let tx, viewResults;
					let collateralBefore;
					let flagReward, liquidateReward;
					let beforeDebtShares, beforeSharesSupply, beforeDebtBalance;
					let beforeFlagRewardCredittedHaka,
						beforeLiquidateRewardCredittedHaka,
						beforeRemainingRewardCredittedHaka;

					before('liquidatorUser calls liquidateDelinquentAccount', async () => {
						flagReward = await Liquidator.flagReward();
						liquidateReward = await Liquidator.liquidateReward();

						collateralBefore = await Tribeone.collateral(user7.address);
						beforeDebtShares = await TribeoneDebtShare.balanceOf(user7.address);
						beforeSharesSupply = await TribeoneDebtShare.totalSupply();
						beforeFlagRewardCredittedHaka = await Tribeone.balanceOf(flaggerUser.address);
						beforeLiquidateRewardCredittedHaka = await Tribeone.balanceOf(liquidatorUser.address);
						beforeRemainingRewardCredittedHaka = await Tribeone.balanceOf(
							LiquidatorRewards.address
						);
						beforeDebtBalance = await Tribeone.debtBalanceOf(user7.address, toBytes32('hUSD'));

						viewResults = await Liquidator.liquidationAmounts(user7.address, false);
						tx = await Tribeone.connect(liquidatorUser).liquidateDelinquentAccount(user7.address);
					});

					it('results correspond to view before liquidation', async () => {
						assert.bnEqual(
							viewResults.totalRedeemed,
							collateralBefore.sub(flagReward.add(liquidateReward))
						);
						assert.bnEqual(viewResults.escrowToLiquidate, 0);
						assert.bnEqual(viewResults.initialDebtBalance, beforeDebtBalance);
						// debt per debt share changes a bit
						assert.bnEqual(viewResults.debtToRemove.toString(), beforeDebtBalance.toString());
					});

					it('removes all transferable collateral from the liquidated user', async () => {
						const collateralAfter = await Tribeone.collateral(user7.address);
						assert.bnLt(collateralAfter, collateralBefore);
						assert.bnEqual(await Tribeone.balanceOf(user7.address), '0');
						assert.bnEqual(
							viewResults.totalRedeemed,
							collateralBefore.sub(flagReward.add(liquidateReward))
						);
					});

					it('reduces the total supply of debt shares by the amount of liquidated debt shares', async () => {
						const afterDebtShares = await TribeoneDebtShare.balanceOf(user7.address);
						const liquidatedDebtShares = beforeDebtShares.sub(afterDebtShares);
						const afterSupply = beforeSharesSupply.sub(liquidatedDebtShares);

						assert.bnEqual(await TribeoneDebtShare.totalSupply(), afterSupply);
					});

					it('should remove the liquidation entry for the user7', async () => {
						assert.isFalse(await Liquidator.isLiquidationOpen(user7.address, false));
						assert.bnEqual(await Liquidator.getLiquidationDeadlineForAccount(user7.address), 0);
					});

					it('transfers the flag reward to flaggerUser', async () => {
						const flagReward = await Liquidator.flagReward();
						assert.bnEqual(
							await Tribeone.balanceOf(flaggerUser.address),
							beforeFlagRewardCredittedHaka.add(flagReward)
						);
					});

					it('transfers the liquidate reward to liquidatorUser', async () => {
						const liquidateReward = await Liquidator.liquidateReward();
						assert.bnEqual(
							await Tribeone.balanceOf(liquidatorUser.address),
							beforeLiquidateRewardCredittedHaka.add(liquidateReward)
						);
					});

					it('transfers the redeemed HAKA to LiquidatorRewards', async () => {
						const { events } = await tx.wait();
						const liqEvent = events.find(l => l.event === 'AccountLiquidated');
						const hakaRedeemed = liqEvent.args.hakaRedeemed;
						assert.bnEqual(
							await Tribeone.balanceOf(LiquidatorRewards.address),
							beforeRemainingRewardCredittedHaka.add(hakaRedeemed)
						);
					});

					it('should allow someUser to claim their share of the liquidation rewards', async () => {
						const earnedReward = await LiquidatorRewards.earned(someUser.address);

						const tx = await LiquidatorRewards.connect(someUser).getReward(someUser.address);

						const { events } = await tx.wait();

						const event = events.find(l => l.event === 'RewardPaid');
						const payee = event.args.user;
						const reward = event.args.reward;

						assert.equal(payee, someUser.address);
						assert.bnEqual(reward, earnedReward);

						const earnedRewardAfterClaiming = await LiquidatorRewards.earned(someUser.address);
						assert.bnEqual(earnedRewardAfterClaiming, '0');
					});
				});
			});
		});

		describe('full liquidation with a majority of collateral in escrow', () => {
			let tx, viewResults;
			let flagReward, liquidateReward;
			let beforeEscrowBalance, beforeDebtBalance;
			let beforeDebtShares, beforeSharesSupply;
			let beforeHakaBalance, beforeRewardsCredittedHaka;

			before('ensure exchange rate is set', async () => {
				exchangeRate = await getRate({ ctx, symbol: 'HAKA' });
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('HAKA'),
					rate: '6000000000000000000', // $6
				});
			});

			before('ensure user8 has alot of escrowed HAKA', async () => {
				flagReward = await Liquidator.flagReward();
				liquidateReward = await Liquidator.liquidateReward();

				await Tribeone.connect(owner).approve(RewardEscrowV2.address, ethers.constants.MaxUint256);

				// 100 entries is a somewhat realistic estimate for an account which as been escrowing for a while and
				// hasnt claimed
				for (let i = 0; i < 100; i++) {
					await RewardEscrowV2.createEscrowEntry(
						user8.address,
						ethers.utils.parseEther('100'), // total 10000
						86400 * 365
					);
				}
			});

			before('user8 stakes their HAKA', async () => {
				await Tribeone.connect(user8).issueMaxSynths();
			});

			before('exchange rate changes to allow liquidation', async () => {
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('HAKA'),
					rate: '300000000000000000', // $0.30
				});
			});

			it('still not open for liquidation because not flagged', async () => {
				assert.equal(await Liquidator.isLiquidationOpen(user8.address, false), false);
			});

			before('liquidatorUser flags user8', async () => {
				await (
					await Liquidator.connect(liquidatorUser).flagAccountForLiquidation(user8.address)
				).wait();
				await skipLiquidationDelay({ ctx });
			});

			it('user8 cannot self liquidate', async () => {
				// because collateral is in escrow
				await assert.revert(
					Tribeone.connect(user8.address).liquidateSelf(),
					'Not open for liquidation'
				);
			});

			before('liquidatorUser calls liquidateDelinquentAccount', async () => {
				beforeHakaBalance = await Tribeone.balanceOf(user8.address);
				beforeEscrowBalance = await RewardEscrowV2.totalEscrowedAccountBalance(user8.address);
				beforeDebtShares = await TribeoneDebtShare.balanceOf(user8.address);
				beforeSharesSupply = await TribeoneDebtShare.totalSupply();
				beforeDebtBalance = await Tribeone.debtBalanceOf(user8.address, toBytes32('hUSD'));
				beforeRewardsCredittedHaka = await Tribeone.balanceOf(LiquidatorRewards.address);

				viewResults = await Liquidator.liquidationAmounts(user8.address, false);
				tx = await Tribeone.connect(liquidatorUser).liquidateDelinquentAccount(user8.address);

				const { gasUsed } = await tx.wait();
				console.log(
					`liquidateDelinquentAccount() with 100 escrow entries gas used: ${Math.round(
						gasUsed / 1000
					).toString()}k`
				);
			});

			after('restore exchange rate', async () => {
				await addAggregatorAndSetRate({
					ctx,
					currencyKey: toBytes32('HAKA'),
					rate: exchangeRate.toString(),
				});
			});

			it('should remove all transferable collateral', async () => {
				const afterHakaBalance = await Tribeone.balanceOf(user8.address);
				assert.bnEqual(afterHakaBalance, '0');
			});

			it('should remove all escrow', async () => {
				const afterEscrowBalance = await RewardEscrowV2.totalEscrowedAccountBalance(user8.address);
				assert.bnEqual(afterEscrowBalance, '0');
			});

			it('should remove all debt', async () => {
				const afterDebtBalance = await Tribeone.debtBalanceOf(user8.address, toBytes32('hUSD'));
				assert.bnEqual(afterDebtBalance, '0');
			});

			it('results correspond to view before liquidation', async () => {
				assert.bnEqual(
					viewResults.totalRedeemed,
					beforeHakaBalance.add(beforeEscrowBalance).sub(flagReward.add(liquidateReward))
				);
				assert.bnEqual(viewResults.escrowToLiquidate, beforeEscrowBalance);
				assert.bnEqual(viewResults.initialDebtBalance, beforeDebtBalance);
				// debt per debt share changes a bit
				assert.bnEqual(viewResults.debtToRemove.toString(), beforeDebtBalance.toString());
			});

			it('should liquidate all debt and redeem all HAKA', async () => {
				// Get event data.
				const { events } = await tx.wait();
				const liqEvent = events.find(l => l.event === 'AccountLiquidated');
				const amountLiquidated = liqEvent.args.amountLiquidated;
				const hakaRedeemed = liqEvent.args.hakaRedeemed;

				assert.bnEqual(
					hakaRedeemed,
					beforeHakaBalance.add(beforeEscrowBalance).sub(flagReward.add(liquidateReward))
				);
				assert.bnEqual(amountLiquidated.toString(), beforeDebtBalance.toString()); // the variance is due to a rounding error as a result of multiplication of the HAKA rate
			});

			it('reduces the total supply of debt shares by the amount of liquidated debt shares', async () => {
				const afterDebtShares = await TribeoneDebtShare.balanceOf(user8.address);
				const liquidatedDebtShares = beforeDebtShares.sub(afterDebtShares);
				const afterSupply = beforeSharesSupply.sub(liquidatedDebtShares);

				assert.bnEqual(await TribeoneDebtShare.totalSupply(), afterSupply);
			});

			it('should not be open for liquidation anymore', async () => {
				assert.isFalse(await Liquidator.isLiquidationOpen(user8.address, false));
				assert.bnEqual(await Liquidator.getLiquidationDeadlineForAccount(user8.address), 0);
			});

			it('transfers the redeemed HAKA + escrow to LiquidatorRewards', async () => {
				const { events } = await tx.wait();
				const liqEvent = events.find(l => l.event === 'AccountLiquidated');
				const hakaRedeemed = liqEvent.args.hakaRedeemed;
				assert.bnEqual(
					await Tribeone.balanceOf(LiquidatorRewards.address),
					beforeRewardsCredittedHaka.add(hakaRedeemed)
				);
			});

			it('should allow someUser to claim their share of the liquidation rewards', async () => {
				const earnedReward = await LiquidatorRewards.earned(someUser.address);

				const tx = await LiquidatorRewards.connect(someUser).getReward(someUser.address);

				const { events } = await tx.wait();

				const event = events.find(l => l.event === 'RewardPaid');
				const payee = event.args.user;
				const reward = event.args.reward;

				assert.equal(payee, someUser.address);
				assert.bnEqual(reward, earnedReward);

				const earnedRewardAfterClaiming = await LiquidatorRewards.earned(someUser.address);
				assert.bnEqual(earnedRewardAfterClaiming, '0');
			});
		});
	});
}

module.exports = {
	itCanLiquidate,
};
