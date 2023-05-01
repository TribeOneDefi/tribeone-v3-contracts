'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

require('./common'); // import common test scaffolding

const { setupContract, setupAllContracts } = require('./setup');

const { fastForwardTo, toUnit } = require('../utils')();

const {
	ensureOnlyExpectedMutativeFunctions,
	updateRatesWithDefaults,
	setupPriceAggregators,
	setStatus,
} = require('./helpers');

const {
	toBytes32,
	constants: { inflationStartTimestampInSecs },
} = require('../..');

contract('TribeOne', async accounts => {
	const [sAUD, sEUR, uUSD, sETH] = ['sAUD', 'sEUR', 'uUSD', 'sETH'].map(toBytes32);

	const [, owner, account1, account2, account3] = accounts;

	let tribeone,
		tribeoneProxy,
		exchangeRates,
		debtCache,
		supplySchedule,
		rewardEscrow,
		rewardEscrowV2,
		addressResolver,
		systemStatus,
		uUSDContract,
		sETHContract;

	before(async () => {
		({
			TribeOne: tribeone,
			ProxyERC20TribeOne: tribeoneProxy,
			AddressResolver: addressResolver,
			ExchangeRates: exchangeRates,
			DebtCache: debtCache,
			SystemStatus: systemStatus,
			RewardEscrow: rewardEscrow,
			RewardEscrowV2: rewardEscrowV2,
			SupplySchedule: supplySchedule,
			SynthuUSD: uUSDContract,
			SynthsETH: sETHContract,
		} = await setupAllContracts({
			accounts,
			synths: ['uUSD', 'sETH', 'sEUR', 'sAUD'],
			contracts: [
				'TribeOne',
				'SupplySchedule',
				'AddressResolver',
				'ExchangeRates',
				'SystemStatus',
				'DebtCache',
				'Issuer',
				'LiquidatorRewards',
				'Exchanger',
				'RewardsDistribution',
				'CollateralManager',
				'RewardEscrowV2', // required for issuer._collateral to read collateral
				'RewardEscrow',
			],
		}));

		// use implementation ABI on the proxy address to simplify calling
		tribeoneProxy = await artifacts.require('TribeOne').at(tribeoneProxy.address);

		await setupPriceAggregators(exchangeRates, owner, [sAUD, sEUR, sETH]);
	});

	addSnapshotBeforeRestoreAfterEach();

	it('ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: tribeone.abi,
			ignoreParents: ['BaseTribeOne'],
			expected: ['emitAtomicSynthExchange', 'migrateEscrowBalanceToRewardEscrowV2'],
		});
	});

	describe('constructor', () => {
		it('should set constructor params on deployment', async () => {
			const TRIBEONE_TOTAL_SUPPLY = web3.utils.toWei('100000000');
			const instance = await setupContract({
				contract: 'TribeOne',
				accounts,
				skipPostDeploy: true,
				args: [account1, account2, owner, TRIBEONE_TOTAL_SUPPLY, addressResolver.address],
			});

			assert.equal(await instance.proxy(), account1);
			assert.equal(await instance.tokenState(), account2);
			assert.equal(await instance.owner(), owner);
			assert.equal(await instance.totalSupply(), TRIBEONE_TOTAL_SUPPLY);
			assert.equal(await instance.resolver(), addressResolver.address);
		});
	});

	describe('mint() - inflationary supply minting', async () => {
		const INITIAL_WEEKLY_SUPPLY = 800000;

		const DAY = 86400;
		const WEEK = 604800;

		const INFLATION_START_DATE = inflationStartTimestampInSecs;
		// Set inflation amount
		beforeEach(async () => {
			await supplySchedule.setInflationAmount(toUnit(INITIAL_WEEKLY_SUPPLY), { from: owner });
		});
		describe('suspension conditions', () => {
			beforeEach(async () => {
				// ensure mint() can succeed by default
				const week234 = INFLATION_START_DATE + WEEK * 234;
				await fastForwardTo(new Date(week234 * 1000));
				await updateRatesWithDefaults({ exchangeRates, owner, debtCache });
				await supplySchedule.setInflationAmount(toUnit(INITIAL_WEEKLY_SUPPLY), { from: owner });
			});
			['System', 'Issuance'].forEach(section => {
				describe(`when ${section} is suspended`, () => {
					beforeEach(async () => {
						await setStatus({ owner, systemStatus, section, suspend: true });
					});
					it('then calling mint() reverts', async () => {
						await assert.revert(tribeone.mint(), 'Operation prohibited');
					});
					describe(`when ${section} is resumed`, () => {
						beforeEach(async () => {
							await setStatus({ owner, systemStatus, section, suspend: false });
						});
						it('then calling mint() succeeds', async () => {
							await tribeone.mint();
						});
					});
				});
			});
		});
		it('should allow tribeone contract to mint for 234 weeks', async () => {
			// fast forward EVM - inflation supply at week 234
			const week234 = INFLATION_START_DATE + WEEK * 234 + DAY;
			await fastForwardTo(new Date(week234 * 1000));
			await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

			const existingSupply = await tribeone.totalSupply();
			const mintableSupply = await supplySchedule.mintableSupply();

			const currentRewardEscrowBalance = await tribeone.balanceOf(rewardEscrow.address);

			// Call mint on TribeOne
			await tribeone.mint();

			const newTotalSupply = await tribeone.totalSupply();
			const minterReward = await supplySchedule.minterReward();

			const expectedEscrowBalance = currentRewardEscrowBalance
				.add(mintableSupply)
				.sub(minterReward);

			// Here we are only checking to 2 decimal places from the excel model referenced above
			// as the precise rounding is not exact but has no effect on the end result to 6 decimals.
			const expectedSupplyToMint = toUnit(INITIAL_WEEKLY_SUPPLY * 234);
			const expectedNewTotalSupply = existingSupply.add(expectedSupplyToMint);
			assert.bnEqual(newTotalSupply, expectedNewTotalSupply);

			assert.bnEqual(newTotalSupply, existingSupply.add(mintableSupply));
			assert.bnEqual(await tribeone.balanceOf(rewardEscrowV2.address), expectedEscrowBalance);
		});

		it('should allow tribeone contract to mint 2 weeks of supply and minus minterReward', async () => {
			// Issue
			const expectedSupplyToMint = toUnit(INITIAL_WEEKLY_SUPPLY * 2);

			// fast forward EVM to Week 3 in of the inflationary supply
			const weekThree = INFLATION_START_DATE + WEEK * 2 + DAY;
			await fastForwardTo(new Date(weekThree * 1000));
			await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

			const existingSupply = await tribeone.totalSupply();
			const mintableSupply = await supplySchedule.mintableSupply();
			const currentRewardEscrowBalance = await tribeone.balanceOf(rewardEscrow.address);

			// call mint on TribeOne
			await tribeone.mint();

			const newTotalSupply = await tribeone.totalSupply();

			const minterReward = await supplySchedule.minterReward();
			const expectedEscrowBalance = currentRewardEscrowBalance
				.add(mintableSupply)
				.sub(minterReward);

			// Here we are only checking to 2 decimal places from the excel model referenced above
			const expectedNewTotalSupply = existingSupply.add(expectedSupplyToMint);
			assert.bnEqual(newTotalSupply, expectedNewTotalSupply);

			assert.bnEqual(newTotalSupply, existingSupply.add(mintableSupply));
			assert.bnEqual(await tribeone.balanceOf(rewardEscrowV2.address), expectedEscrowBalance);
		});

		it('should be able to mint again after another 7 days period', async () => {
			// fast forward EVM to Week 3 in Year 2 schedule starting at UNIX 1553040000+
			const weekThree = INFLATION_START_DATE + 2 * WEEK + 1 * DAY;
			await fastForwardTo(new Date(weekThree * 1000));
			await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

			let existingTotalSupply = await tribeone.totalSupply();
			let mintableSupply = await supplySchedule.mintableSupply();

			// call mint on TribeOne
			await tribeone.mint();

			let newTotalSupply = await tribeone.totalSupply();
			assert.bnEqual(newTotalSupply, existingTotalSupply.add(mintableSupply));

			// fast forward EVM to Week 4
			const weekFour = weekThree + 1 * WEEK + 1 * DAY;
			await fastForwardTo(new Date(weekFour * 1000));
			await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

			existingTotalSupply = await tribeone.totalSupply();
			mintableSupply = await supplySchedule.mintableSupply();

			// call mint on TribeOne
			await tribeone.mint();

			newTotalSupply = await tribeone.totalSupply();
			assert.bnEqual(newTotalSupply, existingTotalSupply.add(mintableSupply));
		});

		it('should revert when trying to mint again within the 7 days period', async () => {
			// fast forward EVM to Week 3 of inflation
			const weekThree = INFLATION_START_DATE + 2 * WEEK + DAY;
			await fastForwardTo(new Date(weekThree * 1000));
			await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

			const existingTotalSupply = await tribeone.totalSupply();
			const mintableSupply = await supplySchedule.mintableSupply();

			// call mint on TribeOne
			await tribeone.mint();

			const newTotalSupply = await tribeone.totalSupply();
			assert.bnEqual(newTotalSupply, existingTotalSupply.add(mintableSupply));

			const weekFour = weekThree + DAY * 1;
			await fastForwardTo(new Date(weekFour * 1000));

			// should revert if try to mint again within 7 day period / mintable supply is 0
			await assert.revert(tribeone.mint(), 'No supply is mintable');
		});
	});

	describe('migration - transfer escrow balances to reward escrow v2', () => {
		let rewardEscrowBalanceBefore;
		beforeEach(async () => {
			// transfer HAKA to rewardEscrow
			await tribeoneProxy.transfer(rewardEscrow.address, toUnit('100'), { from: owner });

			rewardEscrowBalanceBefore = await tribeone.balanceOf(rewardEscrow.address);
		});
		it('should revert if called by non-owner account', async () => {
			await assert.revert(
				tribeone.migrateEscrowBalanceToRewardEscrowV2({ from: account1 }),
				'Only the contract owner may perform this action'
			);
		});
		it('should have transferred reward escrow balance to reward escrow v2', async () => {
			// call the migrate function
			await tribeone.migrateEscrowBalanceToRewardEscrowV2({ from: owner });

			// should have transferred balance to rewardEscrowV2
			assert.bnEqual(await tribeone.balanceOf(rewardEscrowV2.address), rewardEscrowBalanceBefore);

			// rewardEscrow should have 0 balance
			assert.bnEqual(await tribeone.balanceOf(rewardEscrow.address), 0);
		});
	});

	describe('Using a contract to invoke exchangeWithTrackingForInitiator', () => {
		describe('when a third party contract is setup to exchange synths', () => {
			let contractExample;
			let amountOfuUSD;
			beforeEach(async () => {
				amountOfuUSD = toUnit('100');

				const MockThirdPartyExchangeContract = artifacts.require('MockThirdPartyExchangeContract');

				// create a contract
				contractExample = await MockThirdPartyExchangeContract.new(addressResolver.address);

				// ensure rates are set
				await updateRatesWithDefaults({ exchangeRates, owner, debtCache });

				// issue uUSD from the owner
				await tribeone.issueSynths(amountOfuUSD, { from: owner });

				// transfer the uUSD to the contract
				await uUSDContract.transfer(contractExample.address, toUnit('100'), { from: owner });
			});

			describe('when Barrie invokes the exchange function on the contract', () => {
				let txn;
				beforeEach(async () => {
					// Barrie has no sETH to start
					assert.equal(await sETHContract.balanceOf(account3), '0');

					txn = await contractExample.exchange(uUSD, amountOfuUSD, sETH, { from: account3 });
				});
				it('then Barrie has the synths in her account', async () => {
					assert.bnGt(await sETHContract.balanceOf(account3), toUnit('0.01'));
				});
				it('and the contract has none', async () => {
					assert.equal(await sETHContract.balanceOf(contractExample.address), '0');
				});
				it('and the event emitted indicates that Barrie was the destinationAddress', async () => {
					const logs = artifacts.require('TribeOne').decodeLogs(txn.receipt.rawLogs);
					assert.eventEqual(
						logs.find(log => log.event === 'SynthExchange'),
						'SynthExchange',
						{
							account: contractExample.address,
							fromCurrencyKey: uUSD,
							fromAmount: amountOfuUSD,
							toCurrencyKey: sETH,
							toAddress: account3,
						}
					);
				});
			});
		});
	});
});
