const ethers = require('ethers');
const { assert } = require('../../contracts/common');
const { bootstrapDual } = require('../utils/bootstrap');
const { finalizationOnL2 } = require('../utils/optimism');
const { approveIfNeeded } = require('../utils/approve');

describe('deposit() integration tests (L1, L2)', () => {
	const ctx = this;
	bootstrapDual({ ctx });

	const amountToDeposit = ethers.utils.parseEther('10');

	let owner;
	let TribeOne, TribeOneL2, TribeOneBridgeToOptimism, TribeOneBridgeEscrow;

	let ownerBalance, ownerL2Balance, escrowBalance;

	let depositReceipt;

	describe('when the owner deposits HAKA', () => {
		before('target contracts and users', () => {
			({ TribeOne, TribeOneBridgeToOptimism, TribeOneBridgeEscrow } = ctx.l1.contracts);
			({ TribeOne: TribeOneL2 } = ctx.l2.contracts);

			owner = ctx.l1.users.owner;
		});

		before('record balances', async () => {
			ownerBalance = await TribeOne.balanceOf(owner.address);
			ownerL2Balance = await TribeOneL2.balanceOf(owner.address);
			escrowBalance = await TribeOne.balanceOf(TribeOneBridgeEscrow.address);
		});

		before('approve if needed', async () => {
			await approveIfNeeded({
				token: TribeOne,
				owner,
				beneficiary: TribeOneBridgeToOptimism,
				amount: amountToDeposit,
			});
		});

		before('make the deposit', async () => {
			TribeOneBridgeToOptimism = TribeOneBridgeToOptimism.connect(owner);

			const tx = await TribeOneBridgeToOptimism.deposit(amountToDeposit);
			depositReceipt = await tx.wait();
		});

		it('decreases the owner balance', async () => {
			const newOwnerBalance = await TribeOne.balanceOf(owner.address);

			assert.bnEqual(newOwnerBalance, ownerBalance.sub(amountToDeposit));
		});

		it('increases the escrow balance', async () => {
			const newEscrowBalance = await TribeOne.balanceOf(TribeOneBridgeEscrow.address);

			assert.bnEqual(newEscrowBalance, escrowBalance.add(amountToDeposit));
		});

		describe('when the deposit gets picked up in L2', () => {
			before('target contracts and users', () => {
				owner = ctx.l2.users.owner;
			});

			before('wait for deposit finalization', async () => {
				await finalizationOnL2({ ctx, transactionHash: depositReceipt.transactionHash });
			});

			it('increases the owner balance', async () => {
				assert.bnEqual(
					await TribeOneL2.balanceOf(owner.address),
					ownerL2Balance.add(amountToDeposit)
				);
			});
		});
	});
});
