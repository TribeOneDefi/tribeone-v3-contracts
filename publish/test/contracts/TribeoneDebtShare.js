'use strict';

const { contract } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('./common');

const { setupContract } = require('./setup');

const { toUnit } = require('../utils')();

const { onlyGivenAddressCanInvoke, ensureOnlyExpectedMutativeFunctions } = require('./helpers');

const {
	toBytes32,
	constants: { ZERO_ADDRESS },
} = require('../..');

const ethers = require('ethers');

contract('TribeoneDebtShare', async accounts => {
	const [owner, issuer, account1, account2] = accounts;

	let addressResolver, tribeoneDebtShare;

	before(async () => {
		addressResolver = await setupContract({
			accounts,
			args: [owner],
			contract: 'AddressResolver',
		});

		tribeoneDebtShare = await setupContract({
			accounts,
			args: [owner, addressResolver.address],
			contract: 'TribeoneDebtShare',
		});

		await addressResolver.importAddresses([toBytes32('Issuer')], [issuer], { from: owner });
		await tribeoneDebtShare.rebuildCache();
		await tribeoneDebtShare.addAuthorizedBroker(owner);
	});

	addSnapshotBeforeRestoreAfterEach();

	it('ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: tribeoneDebtShare.abi,
			ignoreParents: ['Owned'],
			expected: [
				'mintShare',
				'burnShare',
				'transferFrom',
				'importAddresses',
				'takeSnapshot',
				'addAuthorizedBroker',
				'removeAuthorizedBroker',
				'addAuthorizedToSnapshot',
				'removeAuthorizedToSnapshot',
				'finishSetup',
				'rebuildCache',
			],
		});
	});
	it('should set constructor params on deployment', async () => {
		const instance = await setupContract({
			accounts,
			contract: 'TribeoneDebtShare',
			args: [owner, addressResolver.address],
		});

		assert.equal(await instance.owner(), owner);
	});

	describe('mintShare()', () => {
		it('should disallow another from minting', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: tribeoneDebtShare.mintShare,
				args: [account2, toUnit('0.1')],
				accounts,
				address: issuer,
				skipPassCheck: true,
				reason: 'TribeoneDebtShare: only issuer can mint/burn',
			});
		});

		it('mints', async () => {
			await tribeoneDebtShare.mintShare(account1, toUnit('10'), { from: issuer });

			assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('10'));
			assert.bnEqual(await tribeoneDebtShare.totalSupply(), toUnit('10'));
		});

		it('mints twice on the same period', async () => {
			await tribeoneDebtShare.mintShare(account1, toUnit('10'), { from: issuer });

			assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('10'));
			assert.bnEqual(await tribeoneDebtShare.totalSupply(), toUnit('10'));

			await tribeoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });

			assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('30'));
			assert.bnEqual(await tribeoneDebtShare.totalSupply(), toUnit('30'));
		});

		it('more than one person can mint', async () => {
			await tribeoneDebtShare.mintShare(account1, toUnit('10'), { from: issuer });

			assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('10'));
			assert.bnEqual(await tribeoneDebtShare.totalSupply(), toUnit('10'));

			await tribeoneDebtShare.mintShare(account2, toUnit('20'), { from: issuer });

			assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('10'));
			assert.bnEqual(await tribeoneDebtShare.totalSupply(), toUnit('30'));
		});

		describe('on new period', async () => {
			beforeEach(async () => {
				await tribeoneDebtShare.mintShare(account1, toUnit('10'), { from: issuer });
				await tribeoneDebtShare.takeSnapshot(toUnit('10'), { from: issuer });
			});

			it('mints', async () => {
				await tribeoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });

				assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('30'));
				assert.bnEqual(await tribeoneDebtShare.totalSupply(), toUnit('30'));
			});

			describe('on another new period', () => {
				beforeEach(async () => {
					await tribeoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });
					await tribeoneDebtShare.takeSnapshot(toUnit('50'), { from: issuer });
				});

				it('previous period is preserved', async () => {
					assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('30'));

					await tribeoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });

					assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('50'));

					assert.bnEqual(
						await tribeoneDebtShare.balanceOfOnPeriod(account1, toUnit('10')),
						toUnit('30')
					);
					assert.bnEqual(await tribeoneDebtShare.totalSupplyOnPeriod(toUnit('10')), toUnit('30'));
				});
			});
		});
	});

	describe('burnShare()', () => {
		it('should disallow another from burning', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: tribeoneDebtShare.mintShare,
				args: [account2, toUnit('0.1')],
				address: issuer,
				accounts,
				reason: 'TribeoneDebtShare: only issuer can mint/burn',
			});
		});

		describe('when account already has shares minted', () => {
			beforeEach(async () => {
				await tribeoneDebtShare.mintShare(account1, toUnit('50'), { from: issuer });
				await tribeoneDebtShare.takeSnapshot(toUnit('10'), { from: issuer });
			});

			it('cannot burn more shares than the account has', async () => {
				await assert.revert(
					tribeoneDebtShare.burnShare(account1, toUnit('60'), { from: issuer }),
					'SafeMath: subtraction overflow'
				);
			});

			it('burns', async () => {
				assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('50'));
				await tribeoneDebtShare.burnShare(account1, toUnit('20'), { from: issuer });

				assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('30'));
				assert.bnEqual(await tribeoneDebtShare.totalSupply(), toUnit('30'));
			});

			describe('on another new period', () => {
				beforeEach(async () => {
					await tribeoneDebtShare.burnShare(account1, toUnit('20'), { from: issuer });
					await tribeoneDebtShare.takeSnapshot(toUnit('50'), { from: issuer });
				});

				it('previous period is preserved', async () => {
					await tribeoneDebtShare.burnShare(account1, toUnit('20'), { from: issuer });

					assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('10'));

					assert.bnEqual(
						await tribeoneDebtShare.balanceOfOnPeriod(account1, toUnit('10')),
						toUnit('30')
					);
					assert.bnEqual(await tribeoneDebtShare.totalSupplyOnPeriod(toUnit('10')), toUnit('30'));
				});
			});
		});
	});

	describe('takeSnapshot()', () => {
		it('is only invokable by issuer', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: tribeoneDebtShare.takeSnapshot,
				args: [toUnit('10')],
				address: issuer,
				accounts,
				reason: 'TribeoneDebtShare: not authorized to snapshot',
			});
		});

		describe('when authorized to snapshot address is set', () => {
			beforeEach(async () => {
				await tribeoneDebtShare.addAuthorizedToSnapshot(account1);
			});

			it('becomes invokable by authorized snapshotter', async () => {
				await tribeoneDebtShare.takeSnapshot(toUnit('10'), { from: account1 });
			});
		});

		describe('when successfully invoked', () => {
			beforeEach(async () => {
				await tribeoneDebtShare.mintShare(account1, toUnit('1'), { from: issuer });
				await tribeoneDebtShare.takeSnapshot(toUnit('10'), { from: issuer });
				await tribeoneDebtShare.mintShare(account1, toUnit('1'), { from: issuer });
			});

			it('sets current period id', async () => {
				assert.bnEqual(await tribeoneDebtShare.currentPeriodId(), toUnit('10'));
			});

			it('rolls totalSupply', async () => {
				assert.bnEqual(await tribeoneDebtShare.totalSupply(), toUnit('2'));
				assert.bnEqual(await tribeoneDebtShare.totalSupplyOnPeriod(1), toUnit('1'));
			});

			it('prohibits lower period IDs in the future', async () => {
				await assert.revert(tribeoneDebtShare.takeSnapshot(toUnit('5')));
				await assert.revert(tribeoneDebtShare.takeSnapshot(toUnit('10')));
			});
		});
	});

	describe('authorized broker functions', () => {
		it('only owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: tribeoneDebtShare.addAuthorizedBroker,
				args: [ZERO_ADDRESS],
				address: owner,
				accounts,
				reason: 'Only the contract owner may perform this action',
			});
			await onlyGivenAddressCanInvoke({
				fnc: tribeoneDebtShare.removeAuthorizedBroker,
				args: [ZERO_ADDRESS],
				address: owner,
				accounts,
				reason: 'Only the contract owner may perform this action',
			});
		});

		describe('when successfully invoked', () => {
			beforeEach(async () => {
				await tribeoneDebtShare.addAuthorizedBroker(account1, { from: owner });
			});

			it('sets broker', async () => {
				assert.bnEqual(await tribeoneDebtShare.authorizedBrokers(account1), true);
			});

			describe('when broker is removed', () => {
				beforeEach(async () => {
					await tribeoneDebtShare.removeAuthorizedBroker(account1, { from: owner });
				});

				it('sets broker', async () => {
					assert.bnEqual(await tribeoneDebtShare.authorizedBrokers(account1), false);
				});
			});
		});
	});

	describe('authorized to snapshot functions', () => {
		it('only owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: tribeoneDebtShare.addAuthorizedToSnapshot,
				args: [ZERO_ADDRESS],
				address: owner,
				accounts,
				reason: 'Only the contract owner may perform this action',
			});
			await onlyGivenAddressCanInvoke({
				fnc: tribeoneDebtShare.removeAuthorizedToSnapshot,
				args: [ZERO_ADDRESS],
				address: owner,
				accounts,
				reason: 'Only the contract owner may perform this action',
			});
		});

		describe('when successfully invoked', () => {
			beforeEach(async () => {
				await tribeoneDebtShare.addAuthorizedToSnapshot(account1, { from: owner });
			});

			it('sets authorization', async () => {
				assert.bnEqual(await tribeoneDebtShare.authorizedToSnapshot(account1), true);
			});

			describe('when broker is removed', () => {
				beforeEach(async () => {
					await tribeoneDebtShare.removeAuthorizedToSnapshot(account1, { from: owner });
				});

				it('sets authorization', async () => {
					assert.bnEqual(await tribeoneDebtShare.authorizedToSnapshot(account1), false);
				});
			});
		});
	});

	describe('transfer()', () => {
		it('should always fail', async () => {
			await assert.revert(
				tribeoneDebtShare.transfer(account2, toUnit('0.1')),
				'debt shares are not transferrable'
			);
		});
	});

	describe('approve()', () => {
		it('should always fail', async () => {
			await assert.revert(
				tribeoneDebtShare.approve(account2, toUnit('0.1')),
				'debt shares are not transferrable'
			);
		});
	});

	describe('transferFrom()', () => {
		describe('when account has some debt shares', () => {
			beforeEach(async () => {
				await tribeoneDebtShare.mintShare(account1, toUnit('100'), { from: issuer });
			});

			it('only allows authorized brokers to transferFrom', async () => {
				await onlyGivenAddressCanInvoke({
					fnc: tribeoneDebtShare.transferFrom,
					address: owner,
					args: [account1, account2, toUnit('0.1')],
					accounts,
					reason: 'TribeoneDebtShare: only brokers can transferFrom',
				});
			});

			it('fails transfer if exceeds balance', async () => {
				await assert.revert(tribeoneDebtShare.transferFrom(account1, account2, toUnit('200')), '');
			});

			it('transfers', async () => {
				await tribeoneDebtShare.transferFrom(account1, account2, toUnit('100'));

				assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('0'));
				assert.bnEqual(await tribeoneDebtShare.balanceOf(account2), toUnit('100'));
			});
		});
	});

	describe('allowance()', () => {
		it('returns 0 for non-brokers', async () => {
			assert.bnEqual(await tribeoneDebtShare.allowance(account1, account1), toUnit('0'));
		});

		it('returns MAX_UINT for brokers', async () => {
			assert.bnNotEqual(await tribeoneDebtShare.allowance(owner, owner), toUnit('0'));
		});
	});

	describe('balanceOf()', () => {
		it('returns 0 balance initially', async () => {
			assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('0'));
		});

		describe('when 2 accounts have minted shares', () => {
			beforeEach(async () => {
				await tribeoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });
				await tribeoneDebtShare.mintShare(account2, toUnit('80'), { from: issuer });
			});

			it('returns correct balances', async () => {
				assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('20'));
				assert.bnEqual(await tribeoneDebtShare.balanceOf(account2), toUnit('80'));
			});
		});
	});

	describe('totalSupply()', () => {
		it('returns 0 balance initially', async () => {
			assert.bnEqual(await tribeoneDebtShare.totalSupply(), toUnit('0'));
		});

		describe('when 2 accounts have minted shares', () => {
			beforeEach(async () => {
				await tribeoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });
				await tribeoneDebtShare.mintShare(account2, toUnit('80'), { from: issuer });
			});

			it('returns correct totalSupply', async () => {
				assert.bnEqual(await tribeoneDebtShare.totalSupply(), toUnit('100'));
			});
		});
	});

	describe('balanceOfOnPeriod()', () => {
		addSnapshotBeforeRestoreAfterEach();

		it('returns 0 balance initially', async () => {
			assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('0'));
		});

		describe('when 2 accounts have minted shares', () => {
			beforeEach(async () => {
				await tribeoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });
				await tribeoneDebtShare.mintShare(account2, toUnit('80'), { from: issuer });
			});

			it('returns correct percentages for current period', async () => {
				assert.bnEqual(await tribeoneDebtShare.balanceOfOnPeriod(account1, 1), toUnit('20'));
				assert.bnEqual(await tribeoneDebtShare.balanceOfOnPeriod(account2, 1), toUnit('80'));
			});

			describe('when period changes', () => {
				beforeEach(async () => {
					await tribeoneDebtShare.takeSnapshot(toUnit('100'), { from: issuer });
				});

				it('returns correct percentages for last period', async () => {
					assert.bnEqual(await tribeoneDebtShare.balanceOfOnPeriod(account1, 1), toUnit('20'));
					assert.bnEqual(await tribeoneDebtShare.balanceOfOnPeriod(account2, 1), toUnit('80'));
				});

				it('returns correct percentages for current period', async () => {
					assert.bnEqual(
						await tribeoneDebtShare.balanceOfOnPeriod(account1, toUnit('100')),
						toUnit('20')
					);
					assert.bnEqual(
						await tribeoneDebtShare.balanceOfOnPeriod(account2, toUnit('100')),
						toUnit('80')
					);
				});

				describe('when balance changes on new period', () => {
					beforeEach(async () => {
						await tribeoneDebtShare.mintShare(account1, toUnit('40'), { from: issuer });
					});

					it('returns correct percentages for last period', async () => {
						assert.bnEqual(await tribeoneDebtShare.balanceOfOnPeriod(account1, 1), toUnit('20'));
						assert.bnEqual(await tribeoneDebtShare.balanceOfOnPeriod(account2, 1), toUnit('80'));
					});

					it('returns correct percentages for current period', async () => {
						assert.bnEqual(
							await tribeoneDebtShare.balanceOfOnPeriod(account1, toUnit('100')),
							toUnit('60')
						);
						assert.bnEqual(
							await tribeoneDebtShare.balanceOfOnPeriod(account2, toUnit('100')),
							toUnit('80')
						);
					});

					it('still remembers 0 balance before first mint', async () => {
						assert.bnEqual(await tribeoneDebtShare.balanceOfOnPeriod(account2, 0), 0);
					});
				});
			});
		});

		describe('when there is long period history', () => {
			beforeEach(async () => {
				// one account changes balance every period
				for (let i = 1; i < 100; i++) {
					await tribeoneDebtShare.takeSnapshot(toUnit(i.toString()), { from: issuer });
					await tribeoneDebtShare.mintShare(account1, toUnit('1'), { from: issuer });
				}
			});

			it('has correct latest balance', async () => {
				assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('99'));
			});

			it('has balance from a couple periods ago', async () => {
				assert.bnEqual(
					await tribeoneDebtShare.balanceOfOnPeriod(account1, toUnit('95')),
					toUnit('95')
				);
			});

			it('reverts on oldest period', async () => {
				await assert.revert(
					tribeoneDebtShare.balanceOfOnPeriod(account1, 10),
					'TribeoneDebtShare: not found in recent history'
				);
			});
		});
	});

	describe('sharePercent()', () => {
		describe('when 2 accounts have minted shares', () => {
			beforeEach(async () => {
				await tribeoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });
				await tribeoneDebtShare.mintShare(account2, toUnit('80'), { from: issuer });
			});

			it('returns correct percentages', async () => {
				assert.bnEqual(await tribeoneDebtShare.sharePercent(account1), toUnit('0.2'));
				assert.bnEqual(await tribeoneDebtShare.sharePercent(account2), toUnit('0.8'));
			});
		});
	});

	describe('sharePercentOnPeriod()', () => {
		describe('when 2 accounts have minted shares', () => {
			beforeEach(async () => {
				await tribeoneDebtShare.mintShare(account1, toUnit('20'), { from: issuer });
				await tribeoneDebtShare.mintShare(account2, toUnit('80'), { from: issuer });
			});

			it('returns correct percentages for current period', async () => {
				assert.bnEqual(await tribeoneDebtShare.sharePercentOnPeriod(account1, 1), toUnit('0.2'));
				assert.bnEqual(await tribeoneDebtShare.sharePercentOnPeriod(account2, 1), toUnit('0.8'));
			});

			describe('when period changes', () => {
				beforeEach(async () => {
					await tribeoneDebtShare.takeSnapshot(toUnit('100'), { from: issuer });
				});

				it('returns correct percentages for last period', async () => {
					assert.bnEqual(await tribeoneDebtShare.sharePercentOnPeriod(account1, 1), toUnit('0.2'));
					assert.bnEqual(await tribeoneDebtShare.sharePercentOnPeriod(account2, 1), toUnit('0.8'));
				});

				it('returns correct percentages for current period', async () => {
					assert.bnEqual(await tribeoneDebtShare.sharePercentOnPeriod(account1, 1), toUnit('0.2'));
					assert.bnEqual(await tribeoneDebtShare.sharePercentOnPeriod(account2, 1), toUnit('0.8'));
				});

				describe('when balance changes on new period', () => {
					beforeEach(async () => {
						await tribeoneDebtShare.mintShare(account1, toUnit('100'), { from: issuer });
					});

					it('returns correct percentages for last period', async () => {
						assert.bnEqual(
							await tribeoneDebtShare.sharePercentOnPeriod(account1, 1),
							toUnit('0.2')
						);
						assert.bnEqual(
							await tribeoneDebtShare.sharePercentOnPeriod(account2, 1),
							toUnit('0.8')
						);
					});

					it('returns correct percentages for current period', async () => {
						assert.bnEqual(
							await tribeoneDebtShare.sharePercentOnPeriod(account1, toUnit('100')),
							toUnit('0.6')
						);
						assert.bnEqual(
							await tribeoneDebtShare.sharePercentOnPeriod(account2, toUnit('100')),
							toUnit('0.4')
						);
					});
				});
			});
		});
	});

	describe('importAddresses()', () => {
		it('should disallow import outside of owner', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: tribeoneDebtShare.importAddresses,
				args: [[account2], [toUnit('0.1')]],
				accounts,
				address: owner,
				skipPassCheck: true,
				reason: 'Only the contract owner may perform this action',
			});
		});

		describe('when invoked by owner', () => {
			let txn1, txn2;

			beforeEach(async () => {
				txn1 = await tribeoneDebtShare.importAddresses([account1], [toUnit('20')], {
					from: owner,
				});
				await tribeoneDebtShare.importAddresses([account2, issuer], [toUnit('10'), toUnit('10')], {
					from: owner,
				});
				await tribeoneDebtShare.importAddresses([account2], [toUnit('50')], { from: owner });
				txn2 = await tribeoneDebtShare.importAddresses([account2], [toUnit('30')], {
					from: owner,
				});
			});

			it('sets total supply', async () => {
				assert.bnEqual(await tribeoneDebtShare.totalSupply(), toUnit('60'));
			});

			it('sets balances balances', async () => {
				assert.bnEqual(await tribeoneDebtShare.balanceOf(account1), toUnit('20'));
				assert.bnEqual(await tribeoneDebtShare.balanceOf(account2), toUnit('30'));
				assert.bnEqual(await tribeoneDebtShare.balanceOf(issuer), toUnit('10'));
			});

			it('emits events', async () => {
				assert.eventEqual(txn1.logs[0], 'Mint', [account1, toUnit('20')]);
				assert.eventEqual(txn1.logs[1], 'Transfer', [
					ethers.constants.AddressZero,
					account1,
					toUnit('20'),
				]);

				assert.eventEqual(txn2.logs[0], 'Burn', [account2, toUnit('20')]);
			});
		});
	});

	describe('finishSetup()', () => {
		it('should disallow another from minting', async () => {
			await onlyGivenAddressCanInvoke({
				fnc: tribeoneDebtShare.finishSetup,
				args: [],
				accounts,
				address: owner,
				skipPassCheck: true,
				reason: 'Only the contract owner may perform this action',
			});
		});

		describe('when invoked by owner', () => {
			beforeEach(async () => {
				await tribeoneDebtShare.finishSetup({ from: owner });
			});

			it('becomes initialized', async () => {
				assert.isTrue(await tribeoneDebtShare.isInitialized());
			});
		});
	});
});
