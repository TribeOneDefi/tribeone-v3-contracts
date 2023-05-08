const ethers = require('ethers');
const { toBytes32 } = require('../../../index');
const { assert, addSnapshotBeforeRestoreAfter } = require('../../contracts/common');
const { ensureBalance } = require('../utils/balances');
const { skipMinimumStakeTime } = require('../utils/skip');
const { createMockAggregatorFactory } = require('../../utils/index')();

function itCanStake({ ctx }) {
	describe('staking and claiming', () => {
		const HAKAAmount = ethers.utils.parseEther('1000');
		const amountToIssueAndBurnsUSD = ethers.utils.parseEther('1');

		let tx;
		let user, owner;
		let aggregator;
		let AddressResolver, Tribeone, TribeoneDebtShare, SynthsUSD, Issuer;
		let balancesUSD, debtsUSD;

		addSnapshotBeforeRestoreAfter();

		before('target contracts and users', () => {
			({ AddressResolver, Tribeone, TribeoneDebtShare, SynthsUSD, Issuer } = ctx.contracts);

			user = ctx.users.otherUser;
			owner = ctx.users.owner;
		});

		before('ensure the user has enough HAKA', async () => {
			await ensureBalance({ ctx, symbol: 'HAKA', user, balance: HAKAAmount });
		});

		before('setup mock debt ratio aggregator', async () => {
			const MockAggregatorFactory = await createMockAggregatorFactory(owner);
			aggregator = (await MockAggregatorFactory.deploy()).connect(owner);

			tx = await aggregator.setDecimals(27);
			await tx.wait();

			const { timestamp } = await ctx.provider.getBlock();
			// debt share ratio of 0.5
			tx = await aggregator.setLatestAnswer(ethers.utils.parseUnits('0.5', 27), timestamp);
			await tx.wait();
		});

		before('import the aggregator to the resolver', async () => {
			AddressResolver = AddressResolver.connect(owner);
			tx = await AddressResolver.importAddresses(
				[toBytes32('ext:AggregatorDebtRatio')],
				[aggregator.address]
			);
			await tx.wait();
		});

		before('rebuild caches', async () => {
			tx = await Issuer.connect(owner).rebuildCache();
			await tx.wait();
		});

		describe('when the user issues hUSD', () => {
			before('record balances', async () => {
				balancesUSD = await SynthsUSD.balanceOf(user.address);
				debtsUSD = await TribeoneDebtShare.balanceOf(user.address);
			});

			before('issue hUSD', async () => {
				Tribeone = Tribeone.connect(user);

				const tx = await Tribeone.issueSynths(amountToIssueAndBurnsUSD);
				const { gasUsed } = await tx.wait();
				console.log(`issueSynths() gas used: ${Math.round(gasUsed / 1000).toString()}k`);
			});

			it('issues the expected amount of hUSD', async () => {
				assert.bnEqual(
					await SynthsUSD.balanceOf(user.address),
					balancesUSD.add(amountToIssueAndBurnsUSD)
				);
			});

			it('issues the expected amount of debt shares', async () => {
				// mints (amountToIssueAndBurnsUSD / ratio) = debt shares
				assert.bnEqual(
					await TribeoneDebtShare.balanceOf(user.address),
					debtsUSD.add(amountToIssueAndBurnsUSD.mul(2))
				);
			});

			describe('when the user issues hUSD again', () => {
				before('record balances', async () => {
					balancesUSD = await SynthsUSD.balanceOf(user.address);
					debtsUSD = await TribeoneDebtShare.balanceOf(user.address);
				});

				before('issue hUSD', async () => {
					const tx = await Tribeone.issueSynths(amountToIssueAndBurnsUSD.mul(2));
					await tx.wait();
				});

				it('issues the expected amount of hUSD', async () => {
					assert.bnEqual(
						await SynthsUSD.balanceOf(user.address),
						balancesUSD.add(amountToIssueAndBurnsUSD.mul(2))
					);
				});

				it('issues the expected amount of debt shares', async () => {
					// mints (amountToIssueAndBurnsUSD / ratio) = debt shares
					assert.bnEqual(
						await TribeoneDebtShare.balanceOf(user.address),
						debtsUSD.add(amountToIssueAndBurnsUSD.mul(4))
					);
				});

				describe('when the user burns this new amount of hUSD', () => {
					before('record balances', async () => {
						balancesUSD = await SynthsUSD.balanceOf(user.address);
						debtsUSD = await TribeoneDebtShare.balanceOf(user.address);
					});

					before('skip min stake time', async () => {
						await skipMinimumStakeTime({ ctx });
					});

					before('burn hUSD', async () => {
						const tx = await Tribeone.burnSynths(amountToIssueAndBurnsUSD);
						await tx.wait();
					});

					it('debt should decrease', async () => {
						assert.bnEqual(
							await SynthsUSD.balanceOf(user.address),
							balancesUSD.sub(amountToIssueAndBurnsUSD)
						);
					});

					it('debt share should decrease correctly', async () => {
						// burns (amountToIssueAndBurnsUSD / ratio) = debt shares
						assert.bnEqual(
							await TribeoneDebtShare.balanceOf(user.address),
							debtsUSD.sub(amountToIssueAndBurnsUSD.mul(2))
						);
					});
				});
			});
		});

		describe('when the user burns hUSD again', () => {
			before('skip min stake time', async () => {
				await skipMinimumStakeTime({ ctx });
			});

			before('record debt', async () => {
				debtsUSD = await Tribeone.debtBalanceOf(user.address, toBytes32('hUSD'));
			});

			before('burn hUSD', async () => {
				Tribeone = Tribeone.connect(user);

				const tx = await Tribeone.burnSynths(amountToIssueAndBurnsUSD);
				const { gasUsed } = await tx.wait();
				console.log(`burnSynths() gas used: ${Math.round(gasUsed / 1000).toString()}k`);
			});

			it('reduces the expected amount of debt', async () => {
				const newDebtsUSD = await Tribeone.debtBalanceOf(user.address, toBytes32('hUSD'));
				const debtReduction = debtsUSD.sub(newDebtsUSD);

				const tolerance = ethers.utils.parseUnits('0.01', 'ether');
				assert.bnClose(
					debtReduction.toString(),
					amountToIssueAndBurnsUSD.toString(),
					tolerance.toString()
				);
			});

			it('reduces the expected amount of debt shares', async () => {
				// burns (amountToIssueAndBurnsUSD / ratio) = debt shares
				assert.bnEqual(
					await TribeoneDebtShare.balanceOf(user.address),
					amountToIssueAndBurnsUSD.mul(2)
				);
			});
		});
	});
}

module.exports = {
	itCanStake,
};
