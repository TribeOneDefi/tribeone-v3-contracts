const { assert } = require('../../contracts/common');
const { bootstrapDual } = require('../utils/bootstrap');

const { toBytes32 } = require('../../../index');

const { exchangeSomething } = require('../utils/exchanging');
const { ensureBalance } = require('../utils/balances');
const { skipFeePeriod, skipMinimumStakeTime } = require('../utils/skip');

const ethers = require('ethers');

describe('staking & claiming integration tests (L1, L2)', () => {
	const ctx = this;
	bootstrapDual({ ctx });

	describe('staking and claiming', () => {
		const HAKAAmount = ethers.utils.parseEther('1000');
		const amountToIssueAndBurnsUSD = ethers.utils.parseEther('1');

		let user;
		let Tribeone, SynthsUSD, FeePool;
		let balancesUSD, debtsUSD;

		before('target contracts and users', () => {
			({ Tribeone, SynthsUSD, FeePool } = ctx.l1.contracts);

			user = ctx.l1.users.someUser;
		});

		before('ensure the user has enough HAKA', async () => {
			await ensureBalance({ ctx: ctx.l1, symbol: 'HAKA', user, balance: HAKAAmount });
		});

		describe('when the user issues hUSD', () => {
			before('record balances', async () => {
				balancesUSD = await SynthsUSD.balanceOf(user.address);
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

			describe('claiming', () => {
				before('exchange something', async () => {
					await exchangeSomething({ ctx: ctx.l1 });
				});

				describe('when the fee period closes', () => {
					before('skip fee period', async () => {
						await skipFeePeriod({ ctx: ctx.l1 });
					});

					before('close the current fee period', async () => {
						FeePool = FeePool.connect(ctx.l1.users.owner);

						const tx = await FeePool.closeCurrentFeePeriod();
						await tx.wait();
					});

					describe('when the user claims rewards', () => {
						before('record balances', async () => {
							balancesUSD = await SynthsUSD.balanceOf(user.address);
						});

						before('claim', async () => {
							FeePool = FeePool.connect(user);

							const tx = await FeePool.claimFees();
							const { gasUsed } = await tx.wait();
							console.log(`claimFees() gas used: ${Math.round(gasUsed / 1000).toString()}k`);
						});

						it('shows no change in the users hUSD balance', async () => {
							assert.bnEqual(await SynthsUSD.balanceOf(user.address), balancesUSD);
						});
					});
				});
			});

			describe('when the user burns hUSD', () => {
				before('skip min stake time', async () => {
					await skipMinimumStakeTime({ ctx: ctx.l1 });
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

				it('reduced the expected amount of debt', async () => {
					const newDebtsUSD = await Tribeone.debtBalanceOf(user.address, toBytes32('hUSD'));
					const debtReduction = debtsUSD.sub(newDebtsUSD);

					const tolerance = ethers.utils.parseUnits('0.01', 'ether');
					assert.bnClose(
						debtReduction.toString(),
						amountToIssueAndBurnsUSD.toString(),
						tolerance.toString()
					);
				});
			});
		});
	});
});
