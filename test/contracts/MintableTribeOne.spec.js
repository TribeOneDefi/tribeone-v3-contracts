const { contract, web3 } = require('hardhat');
const { assert } = require('./common');
const { setupAllContracts } = require('./setup');
const { toWei } = web3.utils;
const { toBytes32 } = require('../..');
const BN = require('bn.js');

const TRIBEONE_TOTAL_SUPPLY = toWei('100000000');

contract('MintableTribeOne (spec tests)', accounts => {
	const [, owner, tribeoneBridgeToBase, account1] = accounts;

	let mintableTribeOne;
	let addressResolver;
	let rewardsDistribution;
	let rewardEscrow;
	describe('when system is setup', () => {
		before('deploy a new instance', async () => {
			({
				TribeOne: mintableTribeOne, // we request TribeOne instead of MintableTribeOne because it is renamed in setup.js
				AddressResolver: addressResolver,
				RewardsDistribution: rewardsDistribution,
				RewardEscrowV2: rewardEscrow,
			} = await setupAllContracts({
				accounts,
				contracts: [
					'AddressResolver',
					'MintableTribeOne',
					'RewardsDistribution',
					'RewardEscrowV2',
				],
			}));
			// update resolver
			await addressResolver.importAddresses(
				[toBytes32('TribeOneBridgeToBase')],
				[tribeoneBridgeToBase],
				{
					from: owner,
				}
			);
			// sync cache
			await mintableTribeOne.rebuildCache();
		});

		describe('mintSecondary()', async () => {
			let mintSecondaryTx;
			const amount = 100;
			before('when TribeOneBridgeToBase calls mintSecondary()', async () => {
				mintSecondaryTx = await mintableTribeOne.mintSecondary(account1, amount, {
					from: tribeoneBridgeToBase,
				});
			});

			it('should tranfer the tokens to the right account', async () => {
				assert.equal(await mintableTribeOne.balanceOf(account1), amount);
			});

			it('should increase the total supply', async () => {
				const newSupply = new BN(TRIBEONE_TOTAL_SUPPLY).add(new BN(amount));
				assert.bnEqual(await mintableTribeOne.totalSupply(), newSupply);
			});

			it('should emit a Transfer event', async () => {
				assert.eventEqual(mintSecondaryTx, 'Transfer', {
					from: mintableTribeOne.address,
					to: account1,
					value: amount,
				});
			});
		});

		describe('mintSecondaryRewards()', async () => {
			let mintSecondaryRewardsTx;
			const amount = 100;
			let currentSupply;
			before('record current supply', async () => {
				currentSupply = await mintableTribeOne.totalSupply();
			});

			before('when TribeOneBridgeToBase calls mintSecondaryRewards()', async () => {
				mintSecondaryRewardsTx = await mintableTribeOne.mintSecondaryRewards(amount, {
					from: tribeoneBridgeToBase,
				});
			});

			it('should tranfer the tokens initially to RewardsDistribution which  transfers them to RewardEscrowV2 (no distributions)', async () => {
				assert.equal(await mintableTribeOne.balanceOf(rewardsDistribution.address), 0);
				assert.equal(await mintableTribeOne.balanceOf(rewardEscrow.address), amount);
			});

			it('should increase the total supply', async () => {
				const newSupply = currentSupply.add(new BN(amount));
				assert.bnEqual(await mintableTribeOne.totalSupply(), newSupply);
			});

			it('should emit a Transfer event', async () => {
				assert.eventEqual(mintSecondaryRewardsTx, 'Transfer', {
					from: mintableTribeOne.address,
					to: rewardsDistribution.address,
					value: amount,
				});
			});
		});

		describe('burnSecondary()', async () => {
			let burnSecondaryTx;
			const amount = 100;
			let currentSupply;
			before('record current supply', async () => {
				currentSupply = await mintableTribeOne.totalSupply();
			});

			before('when TribeOneBridgeToBase calls burnSecondary()', async () => {
				burnSecondaryTx = await mintableTribeOne.burnSecondary(account1, amount, {
					from: tribeoneBridgeToBase,
				});
			});
			it('should tranfer the tokens to the right account', async () => {
				assert.equal(await mintableTribeOne.balanceOf(account1), 0);
			});

			it('should decrease the total supply', async () => {
				const newSupply = currentSupply.sub(new BN(amount));
				assert.bnEqual(await mintableTribeOne.totalSupply(), newSupply);
			});

			it('should emit a Transfer event', async () => {
				assert.eventEqual(burnSecondaryTx, 'Transfer', {
					from: account1,
					to: '0x0000000000000000000000000000000000000000',
					value: amount,
				});
			});
		});
	});
});
