const ethers = require('ethers');
const chalk = require('chalk');
const hre = require('hardhat');
const { assert } = require('../../contracts/common');
const { bootstrapDual } = require('../utils/bootstrap');
const { finalizationOnL1 } = require('../utils/optimism');

describe('withdraw() integration tests (L1, L2)', () => {
	const ctx = this;
	bootstrapDual({ ctx });

	const amountToWithdraw = ethers.utils.parseEther('10');

	let owner;
	let TribeOne, TribeOneL1, TribeOneBridgeToBase;

	let ownerBalance, ownerL1Balance;

	let withdrawalReceipt;

	describe('when the owner withdraws HAKA', () => {
		before('target contracts and users', () => {
			({ TribeOne, TribeOneBridgeToBase } = ctx.l2.contracts);
			({ TribeOne: TribeOneL1 } = ctx.l1.contracts);

			owner = ctx.l2.users.owner;
		});

		before('record balances', async () => {
			ownerBalance = await TribeOne.balanceOf(owner.address);
			ownerL1Balance = await TribeOneL1.balanceOf(owner.address);
		});

		before('make the withdrawal', async () => {
			TribeOneBridgeToBase = TribeOneBridgeToBase.connect(owner);

			const tx = await TribeOneBridgeToBase.withdraw(amountToWithdraw);

			withdrawalReceipt = await tx.wait();
		});

		it('decreases the owner balance', async () => {
			const newOwnerBalance = await TribeOne.balanceOf(owner.address);

			assert.bnEqual(newOwnerBalance, ownerBalance.sub(amountToWithdraw));
		});

		describe('when the withdrawal gets picked up in L1', () => {
			before(function() {
				if (!hre.config.debugOptimism) {
					console.log(
						chalk.yellow.bold(
							'WARNING: Skipping until ops tool relayer is stable for L1>L2 finalizations'
						)
					);
					this.skip();
				}
			});

			before('wait for withdrawal finalization', async () => {
				await finalizationOnL1({ ctx, transactionHash: withdrawalReceipt.transactionHash });
			});

			it('increases the owner balance', async () => {
				assert.bnEqual(
					await TribeOneL1.balanceOf(owner.address),
					ownerL1Balance.add(amountToWithdraw)
				);
			});
		});
	});
});
