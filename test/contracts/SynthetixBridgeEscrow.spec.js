const { contract, web3 } = require('hardhat');
const { setupAllContracts } = require('./setup');
const { assert } = require('./common');
const { artifacts } = require('hardhat');
const { toBN } = web3.utils;

contract('TribeoneBridgeEscrow (spec tests) @ovm-skip', accounts => {
	const [, owner, snxBridgeToOptimism, user] = accounts;

	let tribeone, tribeetixProxy, tribeetixBridgeEscrow;

	describe('when deploying the system', () => {
		before('deploy all contracts', async () => {
			({
				Tribeone: tribeone,
				ProxyERC20Tribeone: tribeetixProxy,
				TribeoneBridgeEscrow: tribeetixBridgeEscrow,
			} = await setupAllContracts({
				accounts,
				contracts: ['Tribeone', 'TribeoneBridgeEscrow'],
			}));

			// use implementation ABI on the proxy address to simplify calling
			tribeone = await artifacts.require('Tribeone').at(tribeetixProxy.address);
		});

		describe('approveBridge', () => {
			describe('when invoked by the owner', () => {
				const amount = toBN('1000');

				beforeEach(async () => {
					await tribeone.transfer(tribeetixBridgeEscrow.address, amount, {
						from: owner,
					});
				});

				describe('when there is no approval', () => {
					it(' should fail', async () => {
						await assert.revert(
							tribeone.transferFrom(tribeetixBridgeEscrow.address, user, amount, {
								from: snxBridgeToOptimism,
							}),
							'SafeMath: subtraction overflow'
						);
					});
				});

				describe('when there is approval', () => {
					beforeEach(async () => {
						await tribeetixBridgeEscrow.approveBridge(
							tribeone.address,
							snxBridgeToOptimism,
							amount,
							{
								from: owner,
							}
						);
					});

					describe('when the bridge invokes transferFrom()', () => {
						beforeEach(async () => {
							await tribeone.transferFrom(tribeetixBridgeEscrow.address, user, amount, {
								from: snxBridgeToOptimism,
							});
						});

						it("increases the users's balance", async () => {
							assert.bnEqual(await tribeone.balanceOf(user), amount);
						});
					});
				});
			});
		});
	});
});
