const ethers = require('ethers');
const chalk = require('chalk');
const hre = require('hardhat');
const { assert } = require('../../contracts/common');
const { bootstrapDual } = require('../utils/bootstrap');
const { ensureBalance } = require('../utils/balances');
const { addAggregatorAndSetRate, updateCache } = require('../utils/rates');
const { finalizationOnL2, finalizationOnL1 } = require('../utils/optimism');
const { approveIfNeeded } = require('../utils/approve');
const { skipWaitingPeriod } = require('../utils/skip');
const { toBytes32 } = require('../../..');

describe('initiateSynthTransfer() integration tests (L1, L2)', () => {
	const ctx = this;
	bootstrapDual({ ctx });

	const ETH_RATE = '0.5';

	const amountToDeposit = ethers.utils.parseEther('10');

	const [uUSD, sETH] = [toBytes32('uUSD'), toBytes32('sETH')];

	let owner, ownerL2, user, userL2;
	let SynthuUSD, SynthsETH, TribeOneBridgeToOptimism, SystemSettings;

	let SynthuUSDL2, SynthsETHL2, TribeOneBridgeToBase, SystemSettingsL2, SystemStatusL2;

	let userBalance, userL2Balance;

	let depositReceipt;

	describe('when the owner sends uUSD and sETH', () => {
		before('target contracts and users', () => {
			({ SynthuUSD, SynthsETH, TribeOneBridgeToOptimism, SystemSettings } = ctx.l1.contracts);
			({
				SynthuUSD: SynthuUSDL2,
				SynthsETH: SynthsETHL2,
				TribeOneBridgeToBase,
				SystemSettings: SystemSettingsL2,
				SystemStatus: SystemStatusL2,
			} = ctx.l2.contracts);

			owner = ctx.l1.users.owner;
			ownerL2 = ctx.l2.users.owner;
			user = ctx.l1.users.user9;
			userL2 = ctx.l2.users.user9;
		});

		before('set system settings', async () => {
			let tx;
			tx = await SystemSettings.connect(owner).setCrossChainSynthTransferEnabled(uUSD, 1);
			await tx.wait();
			tx = await SystemSettings.connect(owner).setCrossChainSynthTransferEnabled(sETH, 1);
			await tx.wait();
			tx = await SystemSettingsL2.connect(ownerL2).setCrossChainSynthTransferEnabled(uUSD, 1);
			await tx.wait();
			tx = await SystemSettingsL2.connect(ownerL2).setCrossChainSynthTransferEnabled(sETH, 1);
			await tx.wait();
		});

		before('set rates', async () => {
			await addAggregatorAndSetRate({
				ctx: ctx.l1,
				currencyKey: sETH,
				rate: ethers.utils.parseEther(ETH_RATE),
			});

			await addAggregatorAndSetRate({
				ctx: ctx.l2,
				currencyKey: sETH,
				rate: ethers.utils.parseEther(ETH_RATE),
			});
		});

		before('suspend stuff on L2, transfer should still succeed', async () => {
			// suspending the system is a good way to simulate that no suspensions will stop a transfer from finalizing
			const tx = await SystemStatusL2.connect(ownerL2).suspendSystem(1);
			await tx.wait();
		});

		before('ensure balance', async () => {
			await ensureBalance({
				ctx: ctx.l1,
				symbol: 'sETH',
				user: user,
				balance: amountToDeposit.mul(2),
			});

			await ensureBalance({
				ctx: ctx.l1,
				symbol: 'uUSD',
				user: user,
				balance: amountToDeposit.mul(2),
			});

			await ensureBalance({
				ctx: ctx.l2,
				symbol: 'ETH',
				user: user,
				balance: ethers.utils.parseEther('0.1'),
			});

			await updateCache({ ctx: ctx.l1 });
		});

		before('record balances', async () => {
			userBalance = await SynthuUSD.balanceOf(user.address);
			userL2Balance = await SynthuUSDL2.balanceOf(user.address);
		});

		before('approve if needed', async () => {
			await approveIfNeeded({
				token: SynthsETH,
				owner: user,
				beneficiary: TribeOneBridgeToOptimism,
				amount: amountToDeposit,
			});

			await approveIfNeeded({
				token: SynthuUSD,
				owner: user,
				beneficiary: TribeOneBridgeToOptimism,
				amount: amountToDeposit,
			});
		});

		before('fast forward for settle', async () => {
			await skipWaitingPeriod({ ctx: ctx.l1 });
		});

		before('make 2 deposits', async () => {
			TribeOneBridgeToOptimism = TribeOneBridgeToOptimism.connect(user);

			const tx = await TribeOneBridgeToOptimism.initiateSynthTransfer(
				uUSD,
				user.address,
				amountToDeposit
			);
			await tx.wait();

			const tx2 = await TribeOneBridgeToOptimism.initiateSynthTransfer(
				sETH,
				user.address,
				amountToDeposit
			);
			depositReceipt = await tx2.wait();
		});

		it('decreases the owner balance', async () => {
			const newOwnerBalance = await SynthuUSD.balanceOf(user.address);

			assert.bnEqual(newOwnerBalance, userBalance.sub(amountToDeposit));
		});

		it('records amount sent', async () => {
			// 1 ETH = 1000 USD and we sent equal amount of each. so `amountToDeposit * 1001`
			assert.bnEqual(
				await TribeOneBridgeToOptimism.synthTransferSent(),
				amountToDeposit.add(amountToDeposit.div(2))
			);
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
					await SynthuUSDL2.balanceOf(user.address),
					userL2Balance.add(amountToDeposit)
				);

				assert.bnEqual(
					await SynthsETHL2.balanceOf(user.address),
					userL2Balance.add(amountToDeposit)
				);
			});

			it('records amount received', async () => {
				assert.bnEqual(
					await TribeOneBridgeToBase.synthTransferReceived(),
					amountToDeposit.add(amountToDeposit.div(2))
				);
			});

			describe('send back to L1', () => {
				let withdrawReceipt;

				before('resume L2', async () => {
					const tx = await SystemStatusL2.connect(ownerL2).resumeSystem();
					await tx.wait();
				});

				before('transfer synths', async () => {
					TribeOneBridgeToBase = TribeOneBridgeToBase.connect(userL2);

					const tx = await TribeOneBridgeToBase.initiateSynthTransfer(
						uUSD,
						user.address,
						amountToDeposit
					);
					withdrawReceipt = await tx.wait();
				});

				it('decreases the owner balance', async () => {
					const newBalance = await SynthuUSDL2.balanceOf(user.address);

					assert.bnEqual(newBalance, userL2Balance);
				});

				describe('picked up on L1', () => {
					before('wait for deposit finalization', async function() {
						if (!hre.config.debugOptimism) {
							console.log(
								chalk.yellow.bold(
									'WARNING: Skipping until ops tool relayer is stable for L1>L2 finalizations'
								)
							);
							this.skip();
						}

						await finalizationOnL1({ ctx, transactionHash: withdrawReceipt.transactionHash });
					});

					it('increases the owner balance', async () => {
						assert.bnEqual(await SynthuUSD.balanceOf(user.address), userBalance);
					});
				});
			});
		});
	});
});
