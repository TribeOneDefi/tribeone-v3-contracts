'use strict';

const { contract, web3 } = require('hardhat');

const { assert, addSnapshotBeforeRestoreAfterEach } = require('../contracts/common');

const { toUnit } = require('../utils')();

const { setupAllContracts, setupContract, mockToken } = require('../contracts/setup');

const {
	ensureOnlyExpectedMutativeFunctions,
	setupPriceAggregators,
	updateAggregatorRates,
} = require('../contracts/helpers');

const {
	toBytes32,
	defaults: { HAKA_LIQUIDATION_PENALTY },
} = require('../..');

contract('CollateralUtil', async accounts => {
	const uUSD = toBytes32('uUSD');
	const sETH = toBytes32('sETH');
	const sBTC = toBytes32('sBTC');

	const oneRenBTC = web3.utils.toBN('100000000');
	const oneThousanduUSD = toUnit(1000);
	const fiveThousanduUSD = toUnit(5000);

	let tx;
	let id;

	const name = 'Some name';
	const symbol = 'TOKEN';

	const [, owner, , , account1] = accounts;

	let cerc20,
		managerState,
		feePool,
		exchangeRates,
		addressResolver,
		uUSDSynth,
		sBTCSynth,
		renBTC,
		synths,
		manager,
		issuer,
		util,
		debtCache,
		systemSettings;

	const getid = tx => {
		const event = tx.logs.find(log => log.event === 'LoanCreated');
		return event.args.id;
	};

	const issueuUSDToAccount = async (issueAmount, receiver) => {
		// Set up the depositor with an amount of synths to deposit.
		await uUSDSynth.issue(receiver, issueAmount, {
			from: owner,
		});
	};

	const issuesBTCtoAccount = async (issueAmount, receiver) => {
		await sBTCSynth.issue(receiver, issueAmount, { from: owner });
	};

	const issueRenBTCtoAccount = async (issueAmount, receiver) => {
		await renBTC.transfer(receiver, issueAmount, { from: owner });
	};

	const deployCollateral = async ({
		owner,
		manager,
		resolver,
		collatKey,
		minColat,
		minSize,
		underCon,
		decimals,
	}) => {
		return setupContract({
			accounts,
			contract: 'CollateralErc20',
			args: [owner, manager, resolver, collatKey, minColat, minSize, underCon, decimals],
		});
	};

	const setupMultiCollateral = async () => {
		synths = ['uUSD', 'sBTC'];
		({
			ExchangeRates: exchangeRates,
			SynthuUSD: uUSDSynth,
			SynthsBTC: sBTCSynth,
			FeePool: feePool,
			AddressResolver: addressResolver,
			Issuer: issuer,
			CollateralUtil: util,
			DebtCache: debtCache,
			CollateralManager: manager,
			CollateralManagerState: managerState,
			SystemSettings: systemSettings,
		} = await setupAllContracts({
			accounts,
			synths,
			contracts: [
				'TribeOne',
				'FeePool',
				'AddressResolver',
				'ExchangeRates',
				'SystemStatus',
				'Issuer',
				'DebtCache',
				'Exchanger',
				'CollateralUtil',
				'CollateralManager',
				'CollateralManagerState',
				'SystemSettings',
			],
		}));

		await setupPriceAggregators(exchangeRates, owner, [sBTC, sETH]);

		await managerState.setAssociatedContract(manager.address, { from: owner });

		({ token: renBTC } = await mockToken({
			accounts,
			name,
			symbol,
			supply: 1e6,
		}));

		cerc20 = await deployCollateral({
			owner: owner,
			manager: manager.address,
			resolver: addressResolver.address,
			collatKey: sBTC,
			minColat: toUnit(1.5),
			minSize: toUnit(0.1),
			underCon: renBTC.address,
			decimals: 8,
		});

		await addressResolver.importAddresses(
			[toBytes32('CollateralErc20'), toBytes32('CollateralManager')],
			[cerc20.address, manager.address],
			{
				from: owner,
			}
		);

		await feePool.rebuildCache();
		await manager.rebuildCache();
		await issuer.rebuildCache();
		await debtCache.rebuildCache();

		await manager.addCollaterals([cerc20.address], { from: owner });

		await cerc20.addSynths(
			['SynthuUSD', 'SynthsBTC'].map(toBytes32),
			['uUSD', 'sBTC'].map(toBytes32),
			{ from: owner }
		);

		await manager.addSynths(
			['SynthuUSD', 'SynthsBTC'].map(toBytes32),
			['uUSD', 'sBTC'].map(toBytes32),
			{ from: owner }
		);
		// rebuild the cache to add the synths we need.
		await manager.rebuildCache();

		// Issue ren and set allowance
		await issueRenBTCtoAccount(100 * 1e8, account1);
		await renBTC.approve(cerc20.address, 100 * 1e8, { from: account1 });
	};

	before(async () => {
		await setupMultiCollateral();
	});

	addSnapshotBeforeRestoreAfterEach();

	beforeEach(async () => {
		await updateAggregatorRates(exchangeRates, null, [sETH, sBTC], [100, 10000].map(toUnit));

		await issueuUSDToAccount(toUnit(1000), owner);
		await issuesBTCtoAccount(toUnit(10), owner);

		await debtCache.takeDebtSnapshot();
	});

	it('should ensure only expected functions are mutative', async () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: util.abi,
			ignoreParents: ['MixinResolver'],
			expected: [],
		});
	});

	describe('Default settings', () => {
		it('snx liquidation penalty', async () => {
			const snxLiquidationPenalty = await systemSettings.snxLiquidationPenalty();
			assert.bnEqual(snxLiquidationPenalty, HAKA_LIQUIDATION_PENALTY);
		});
	});

	describe('liquidation amount test', async () => {
		let amountToLiquidate;

		/**
		 * r = target issuance ratio
		 * D = debt balance in uUSD
		 * V = Collateral VALUE in uUSD
		 * P = liquidation penalty
		 * Calculates amount of uUSD = (D - V * r) / (1 - (1 + P) * r)
		 *
		 * To go back to another synth, remember to do effective value
		 */

		beforeEach(async () => {
			tx = await cerc20.open(oneRenBTC, fiveThousanduUSD, uUSD, {
				from: account1,
			});

			id = getid(tx);
		});

		it('when we start at 200%, we can take a 25% reduction in collateral prices', async () => {
			await updateAggregatorRates(exchangeRates, null, [sBTC], [toUnit(7500)]);

			amountToLiquidate = await cerc20.liquidationAmount(id);

			assert.bnEqual(amountToLiquidate, toUnit(0));
		});

		it('when we start at 200%, a price shock of 30% in the collateral requires 25% of the loan to be liquidated', async () => {
			await updateAggregatorRates(exchangeRates, null, [sBTC], [toUnit(7000)]);

			amountToLiquidate = await cerc20.liquidationAmount(id);

			assert.bnClose(amountToLiquidate, toUnit(1250), '10000');
		});

		it('when we start at 200%, a price shock of 40% in the collateral requires 75% of the loan to be liquidated', async () => {
			await updateAggregatorRates(exchangeRates, null, [sBTC], [toUnit(6000)]);

			amountToLiquidate = await cerc20.liquidationAmount(id);

			assert.bnClose(amountToLiquidate, toUnit(3750), '10000');
		});

		it('when we start at 200%, a price shock of 45% in the collateral requires 100% of the loan to be liquidated', async () => {
			await updateAggregatorRates(exchangeRates, null, [sBTC], [toUnit(5500)]);
			amountToLiquidate = await cerc20.liquidationAmount(id);

			assert.bnClose(amountToLiquidate, toUnit(5000), '10000');
		});

		it('ignores snxLiquidationPenalty when calculating the liquidation amount (uses liquidationPenalty)', async () => {
			await updateAggregatorRates(exchangeRates, null, [sBTC], [toUnit(7000)]);

			await systemSettings.setSnxLiquidationPenalty(toUnit('0.2'), { from: owner });
			amountToLiquidate = await cerc20.liquidationAmount(id);

			assert.bnClose(amountToLiquidate, toUnit(1250), '10000');

			await systemSettings.setSnxLiquidationPenalty(toUnit('.1'), { from: owner });
			amountToLiquidate = await cerc20.liquidationAmount(id);

			assert.bnClose(amountToLiquidate, toUnit(1250), '10000');
		});
	});

	describe('collateral redeemed test', async () => {
		let collateralRedeemed;
		let collateralKey;

		beforeEach(async () => {
			collateralKey = await cerc20.collateralKey();
		});

		it('when BTC is @ $10000 and we are liquidating 1000 uUSD, then redeem 0.11 BTC', async () => {
			collateralRedeemed = await util.collateralRedeemed(uUSD, oneThousanduUSD, collateralKey);

			assert.bnEqual(collateralRedeemed, toUnit(0.11));
		});

		it('when BTC is @ $20000 and we are liquidating 1000 uUSD, then redeem 0.055 BTC', async () => {
			await updateAggregatorRates(exchangeRates, null, [sBTC], [toUnit(20000)]);

			collateralRedeemed = await util.collateralRedeemed(uUSD, oneThousanduUSD, collateralKey);

			assert.bnEqual(collateralRedeemed, toUnit(0.055));
		});

		it('when BTC is @ $7000 and we are liquidating 2500 uUSD, then redeem 0.36666 BTC', async () => {
			await updateAggregatorRates(exchangeRates, null, [sBTC], [toUnit(7000)]);

			collateralRedeemed = await util.collateralRedeemed(uUSD, toUnit(2500), collateralKey);

			assert.bnClose(collateralRedeemed, toUnit(0.392857142857142857), '100');
		});

		it('regardless of BTC price, we liquidate 1.1 * amount when doing sETH', async () => {
			collateralRedeemed = await util.collateralRedeemed(sBTC, toUnit(1), collateralKey);

			assert.bnEqual(collateralRedeemed, toUnit(1.1));

			await updateAggregatorRates(exchangeRates, null, [sBTC], [toUnit(1000)]);

			collateralRedeemed = await util.collateralRedeemed(sBTC, toUnit(1), collateralKey);

			assert.bnEqual(collateralRedeemed, toUnit(1.1));
		});
	});
});
