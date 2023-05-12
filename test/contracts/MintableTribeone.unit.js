const { artifacts, contract, web3 } = require('hardhat');
const { assert } = require('./common');
const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');
const { toWei } = web3.utils;
const { toBytes32 } = require('../..');
const BN = require('bn.js');
const { smock } = require('@defi-wonderland/smock');

const MintableTribeone = artifacts.require('MintableTribeone');

contract('MintableTribeone (unit tests)', accounts => {
	const [owner, tribeoneBridgeToBase, user1, mockAddress] = accounts;

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: MintableTribeone.abi,
			ignoreParents: ['BaseTribeone'],
			expected: [],
		});
	});

	describe('initial setup, smock all deps', () => {
		let resolver;
		let tokenState;
		let proxy;
		let rewardsDistribution;
		let systemStatus;
		let rewardEscrowV2;
		const TRIBEONE_TOTAL_SUPPLY = toWei('100000000');

		beforeEach(async () => {
			tokenState = await smock.fake('TokenState');
			proxy = await smock.fake('Proxy');
			rewardsDistribution = await smock.fake('IRewardsDistribution');
			resolver = await artifacts.require('AddressResolver').new(owner);
			systemStatus = await artifacts.require('SystemStatus').new(owner);
			rewardEscrowV2 = await smock.fake('IRewardEscrowV2');
			await resolver.importAddresses(
				[
					'TribeoneBridgeToBase',
					'SystemStatus',
					'Exchanger',
					'Issuer',
					'SupplySchedule',
					'Liquidator',
					'LiquidatorRewards',
					'RewardsDistribution',
					'RewardEscrowV2',
				].map(toBytes32),
				[
					tribeoneBridgeToBase,
					systemStatus.address,
					mockAddress,
					mockAddress,
					mockAddress,
					mockAddress,
					mockAddress,
					rewardsDistribution.address,
					rewardEscrowV2.address,
				],
				{ from: owner }
			);
		});

		beforeEach(async () => {
			// stubs
			tokenState.setBalanceOf.returns(() => {});
			tokenState.balanceOf.returns(() => web3.utils.toWei('1'));
			proxy._emit.returns(() => {});
			rewardsDistribution.distributeRewards.returns(() => true);
		});

		describe('when the target is deployed', () => {
			let instance;
			beforeEach(async () => {
				instance = await artifacts
					.require('MintableTribeone')
					.new(proxy.address, tokenState.address, owner, TRIBEONE_TOTAL_SUPPLY, resolver.address);
				await instance.rebuildCache();
			});

			it('should set constructor params on deployment', async () => {
				assert.equal(await instance.proxy(), proxy.address);
				assert.equal(await instance.tokenState(), tokenState.address);
				assert.equal(await instance.owner(), owner);
				assert.equal(await instance.totalSupply(), TRIBEONE_TOTAL_SUPPLY);
				assert.equal(await instance.resolver(), resolver.address);
			});

			describe('mintSecondary()', async () => {
				describe('failure modes', () => {
					it('should only allow TribeoneBridgeToBase to call mintSecondary()', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: instance.mintSecondary,
							args: [user1, 100],
							address: tribeoneBridgeToBase,
							accounts,
							reason: 'Can only be invoked by bridge',
						});
					});
				});

				describe('when invoked by the bridge', () => {
					const amount = 100;
					beforeEach(async () => {
						await instance.mintSecondary(user1, amount, {
							from: tribeoneBridgeToBase,
						});
					});

					it('should increase the total supply', async () => {
						const newSupply = new BN(TRIBEONE_TOTAL_SUPPLY).add(new BN(amount));
						assert.bnEqual(await instance.totalSupply(), newSupply);
					});
				});
			});

			describe('mintSecondaryRewards()', async () => {
				const amount = 100;
				describe('failure modes', () => {
					it('should only allow TribeoneBridgeToBase to call mintSecondaryRewards()', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: instance.mintSecondaryRewards,
							args: [amount],
							address: tribeoneBridgeToBase,
							accounts,
							reason: 'Can only be invoked by bridge',
						});
					});
				});

				describe('when invoked by the bridge', () => {
					beforeEach(async () => {
						await instance.mintSecondaryRewards(amount, {
							from: tribeoneBridgeToBase,
						});
					});

					it('should increase the total supply', async () => {
						const newSupply = new BN(TRIBEONE_TOTAL_SUPPLY).add(new BN(amount));
						assert.bnEqual(await instance.totalSupply(), newSupply);
					});
				});
			});

			describe('burnSecondary()', async () => {
				const amount = 100;
				describe('failure modes', () => {
					it('should only allow TribeoneBridgeToBase to call burnSecondary()', async () => {
						await onlyGivenAddressCanInvoke({
							fnc: instance.burnSecondary,
							args: [user1, amount],
							address: tribeoneBridgeToBase,
							accounts,
							reason: 'Can only be invoked by bridge',
						});
					});
				});
				describe('when invoked by the bridge', () => {
					beforeEach(async () => {
						await instance.burnSecondary(user1, amount, {
							from: tribeoneBridgeToBase,
						});
					});

					it('should decrease the total supply', async () => {
						const newSupply = new BN(TRIBEONE_TOTAL_SUPPLY).sub(new BN(amount));
						assert.bnEqual(await instance.totalSupply(), newSupply);
					});
				});
			});
		});
	});
});
