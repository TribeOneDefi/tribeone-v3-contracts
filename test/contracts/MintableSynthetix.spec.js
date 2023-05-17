const { contract, web3 } = require('hardhat');
const { assert } = require('./common');
const { setupAllContracts } = require('./setup');
const { toWei } = web3.utils;
const { toBytes32 } = require('../..');
const BN = require('bn.js');

const TRIBEONEETIX_TOTAL_SUPPLY = toWei('100000000');

contract('MintableTribeone (spec tests)', accounts => {
	const [, owner, tribeetixBridgeToBase, account1] = accounts;

	let mintableTribeone;
	let addressResolver;
	let rewardsDistribution;
	let rewardEscrow;
	describe('when system is setup', () => {
		before('deploy a new instance', async () => {
			({
				Tribeone: mintableTribeone, // we request Tribeone instead of MintableTribeone because it is renamed in setup.js
				AddressResolver: addressResolver,
				RewardsDistribution: rewardsDistribution,
				RewardEscrowV2: rewardEscrow,
			} = await setupAllContracts({
				accounts,
				contracts: [
					'AddressResolver',
					'MintableTribeone',
					'RewardsDistribution',
					'RewardEscrowV2',
				],
			}));
			// update resolver
			await addressResolver.importAddresses(
				[toBytes32('TribeoneBridgeToBase')],
				[tribeetixBridgeToBase],
				{
					from: owner,
				}
			);
			// sync cache
			await mintableTribeone.rebuildCache();
		});

		describe('mintSecondary()', async () => {
			let mintSecondaryTx;
			const amount = 100;
			before('when TribeoneBridgeToBase calls mintSecondary()', async () => {
				mintSecondaryTx = await mintableTribeone.mintSecondary(account1, amount, {
					from: tribeetixBridgeToBase,
				});
			});

			it('should tranfer the tokens to the right account', async () => {
				assert.equal(await mintableTribeone.balanceOf(account1), amount);
			});

			it('should increase the total supply', async () => {
				const newSupply = new BN(TRIBEONEETIX_TOTAL_SUPPLY).add(new BN(amount));
				assert.bnEqual(await mintableTribeone.totalSupply(), newSupply);
			});

			it('should emit a Transfer event', async () => {
				assert.eventEqual(mintSecondaryTx, 'Transfer', {
					from: mintableTribeone.address,
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
				currentSupply = await mintableTribeone.totalSupply();
			});

			before('when TribeoneBridgeToBase calls mintSecondaryRewards()', async () => {
				mintSecondaryRewardsTx = await mintableTribeone.mintSecondaryRewards(amount, {
					from: tribeetixBridgeToBase,
				});
			});

			it('should tranfer the tokens initially to RewardsDistribution which  transfers them to RewardEscrowV2 (no distributions)', async () => {
				assert.equal(await mintableTribeone.balanceOf(rewardsDistribution.address), 0);
				assert.equal(await mintableTribeone.balanceOf(rewardEscrow.address), amount);
			});

			it('should increase the total supply', async () => {
				const newSupply = currentSupply.add(new BN(amount));
				assert.bnEqual(await mintableTribeone.totalSupply(), newSupply);
			});

			it('should emit a Transfer event', async () => {
				assert.eventEqual(mintSecondaryRewardsTx, 'Transfer', {
					from: mintableTribeone.address,
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
				currentSupply = await mintableTribeone.totalSupply();
			});

			before('when TribeoneBridgeToBase calls burnSecondary()', async () => {
				burnSecondaryTx = await mintableTribeone.burnSecondary(account1, amount, {
					from: tribeetixBridgeToBase,
				});
			});
			it('should tranfer the tokens to the right account', async () => {
				assert.equal(await mintableTribeone.balanceOf(account1), 0);
			});

			it('should decrease the total supply', async () => {
				const newSupply = currentSupply.sub(new BN(amount));
				assert.bnEqual(await mintableTribeone.totalSupply(), newSupply);
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
