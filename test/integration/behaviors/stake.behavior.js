const ethers = require('ethers');
const { toBytes32 } = require('../../../index');
const { assert, addSnapshotBeforeRestoreAfter } = require('../../contracts/common');
const { ensureBalance } = require('../utils/balances');
const { skipMinimumStakeTime } = require('../utils/skip');
const { createMockAggregatorFactory } = require('../../utils/index')();

function itCanStake({ ctx }) {
	describe('staking and claiming', () => {
		const HAKAAmount = ethers.utils.parseEther('1000');
		const amountToIssueAndBurnuUSD = ethers.utils.parseEther('1');

		let tx;
		let user, owner;
		let aggregator;
		let AddressResolver, TribeOne, TribeOneDebtShare, SynthuUSD, Issuer;
		let balanceuUSD, debtuUSD;

		addSnapshotBeforeRestoreAfter();

		before('target contracts and users', () => {
			({ AddressResolver, TribeOne, TribeOneDebtShare, SynthuUSD, Issuer } = ctx.contracts);

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

		describe('when the user issues uUSD', () => {
			before('record balances', async () => {
				balanceuUSD = await SynthuUSD.balanceOf(user.address);
				debtuUSD = await TribeOneDebtShare.balanceOf(user.address);
			});

			before('issue uUSD', async () => {
				TribeOne = TribeOne.connect(user);

				const tx = await TribeOne.issueSynths(amountToIssueAndBurnuUSD);
				const { gasUsed } = await tx.wait();
				console.log(`issueSynths() gas used: ${Math.round(gasUsed / 1000).toString()}k`);
			});

			it('issues the expected amount of uUSD', async () => {
				assert.bnEqual(
					await SynthuUSD.balanceOf(user.address),
					balanceuUSD.add(amountToIssueAndBurnuUSD)
				);
			});

			it('issues the expected amount of debt shares', async () => {
				// mints (amountToIssueAndBurnuUSD / ratio) = debt shares
				assert.bnEqual(
					await TribeOneDebtShare.balanceOf(user.address),
					debtuUSD.add(amountToIssueAndBurnuUSD.mul(2))
				);
			});

			describe('when the user issues uUSD again', () => {
				before('record balances', async () => {
					balanceuUSD = await SynthuUSD.balanceOf(user.address);
					debtuUSD = await TribeOneDebtShare.balanceOf(user.address);
				});

				before('issue uUSD', async () => {
					const tx = await TribeOne.issueSynths(amountToIssueAndBurnuUSD.mul(2));
					await tx.wait();
				});

				it('issues the expected amount of uUSD', async () => {
					assert.bnEqual(
						await SynthuUSD.balanceOf(user.address),
						balanceuUSD.add(amountToIssueAndBurnuUSD.mul(2))
					);
				});

				it('issues the expected amount of debt shares', async () => {
					// mints (amountToIssueAndBurnuUSD / ratio) = debt shares
					assert.bnEqual(
						await TribeOneDebtShare.balanceOf(user.address),
						debtuUSD.add(amountToIssueAndBurnuUSD.mul(4))
					);
				});

				describe('when the user burns this new amount of uUSD', () => {
					before('record balances', async () => {
						balanceuUSD = await SynthuUSD.balanceOf(user.address);
						debtuUSD = await TribeOneDebtShare.balanceOf(user.address);
					});

					before('skip min stake time', async () => {
						await skipMinimumStakeTime({ ctx });
					});

					before('burn uUSD', async () => {
						const tx = await TribeOne.burnSynths(amountToIssueAndBurnuUSD);
						await tx.wait();
					});

					it('debt should decrease', async () => {
						assert.bnEqual(
							await SynthuUSD.balanceOf(user.address),
							balanceuUSD.sub(amountToIssueAndBurnuUSD)
						);
					});

					it('debt share should decrease correctly', async () => {
						// burns (amountToIssueAndBurnuUSD / ratio) = debt shares
						assert.bnEqual(
							await TribeOneDebtShare.balanceOf(user.address),
							debtuUSD.sub(amountToIssueAndBurnuUSD.mul(2))
						);
					});
				});
			});
		});

		describe('when the user burns uUSD again', () => {
			before('skip min stake time', async () => {
				await skipMinimumStakeTime({ ctx });
			});

			before('record debt', async () => {
				debtuUSD = await TribeOne.debtBalanceOf(user.address, toBytes32('uUSD'));
			});

			before('burn uUSD', async () => {
				TribeOne = TribeOne.connect(user);

				const tx = await TribeOne.burnSynths(amountToIssueAndBurnuUSD);
				const { gasUsed } = await tx.wait();
				console.log(`burnSynths() gas used: ${Math.round(gasUsed / 1000).toString()}k`);
			});

			it('reduces the expected amount of debt', async () => {
				const newDebtuUSD = await TribeOne.debtBalanceOf(user.address, toBytes32('uUSD'));
				const debtReduction = debtuUSD.sub(newDebtuUSD);

				const tolerance = ethers.utils.parseUnits('0.01', 'ether');
				assert.bnClose(
					debtReduction.toString(),
					amountToIssueAndBurnuUSD.toString(),
					tolerance.toString()
				);
			});

			it('reduces the expected amount of debt shares', async () => {
				// burns (amountToIssueAndBurnuUSD / ratio) = debt shares
				assert.bnEqual(
					await TribeOneDebtShare.balanceOf(user.address),
					amountToIssueAndBurnuUSD.mul(2)
				);
			});
		});
	});
}

module.exports = {
	itCanStake,
};
