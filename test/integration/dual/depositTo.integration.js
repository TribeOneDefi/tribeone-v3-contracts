const ethers = require('ethers');
const { assert } = require('../../contracts/common');
const { bootstrapDual } = require('../utils/bootstrap');
const { finalizationOnL2 } = require('../utils/optimism');
const { approveIfNeeded } = require('../utils/approve');

describe('depositTo() integration tests (L1, L2)', () => {
	const ctx = this;
	bootstrapDual({ ctx });

	const amountToDeposit = ethers.utils.parseEther('10');

	let owner, user;
	let Tribeone, TribeoneL2, TribeoneBridgeToOptimism, TribeoneBridgeEscrow;

	let ownerBalance, beneficiaryBalance, escrowBalance;

	let depositReceipt;

	describe('when the owner deposits HAKA for a user', () => {
		before('target contracts and users', () => {
			({ Tribeone, TribeoneBridgeToOptimism, TribeoneBridgeEscrow } = ctx.l1.contracts);
			({ Tribeone: TribeoneL2 } = ctx.l2.contracts);

			owner = ctx.l1.users.owner;
			user = ctx.l1.users.someUser;
		});

		before('record balances', async () => {
			ownerBalance = await Tribeone.balanceOf(owner.address);
			escrowBalance = await Tribeone.balanceOf(TribeoneBridgeEscrow.address);
			beneficiaryBalance = await TribeoneL2.balanceOf(user.address);
		});

		before('approve if needed', async () => {
			await approveIfNeeded({
				token: Tribeone,
				owner,
				beneficiary: TribeoneBridgeToOptimism,
				amount: amountToDeposit,
			});
		});

		before('make the deposit', async () => {
			TribeoneBridgeToOptimism = TribeoneBridgeToOptimism.connect(owner);

			const tx = await TribeoneBridgeToOptimism.depositTo(user.address, amountToDeposit);
			depositReceipt = await tx.wait();
		});

		it('decreases the owner balance', async () => {
			const newOwnerBalance = await Tribeone.balanceOf(owner.address);

			assert.bnEqual(newOwnerBalance, ownerBalance.sub(amountToDeposit));
		});

		it('increases the escrow balance', async () => {
			const newEscrowBalance = await Tribeone.balanceOf(TribeoneBridgeEscrow.address);

			assert.bnEqual(newEscrowBalance, escrowBalance.add(amountToDeposit));
		});

		describe('when the deposit gets picked up in L2', () => {
			before('target contracts and users', () => {
				({ Tribeone } = ctx.l2.contracts);

				owner = ctx.l2.users.owner;
			});

			before('wait for deposit finalization', async () => {
				await finalizationOnL2({ ctx, transactionHash: depositReceipt.transactionHash });
			});

			it('increases the beneficiary balance', async () => {
				assert.bnEqual(
					await TribeoneL2.balanceOf(user.address),
					beneficiaryBalance.add(amountToDeposit)
				);
			});
		});
	});
});
