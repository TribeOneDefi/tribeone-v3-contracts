const fs = require('fs');
const path = require('path');
const assert = require('assert');
const pLimit = require('p-limit');

const ethers = require('ethers');
const isCI = require('is-ci');

const { loadLocalWallets } = require('../test-utils/wallets');
const { fastForward } = require('../test-utils/rpc');

const deployStakingRewardsCmd = require('../../publish/src/commands/deploy-staking-rewards');
const deployShortingRewardsCmd = require('../../publish/src/commands/deploy-shorting-rewards');
const deployCmd = require('../../publish/src/commands/deploy');
const testUtils = require('../utils');

const commands = {
	build: require('../../publish/src/commands/build').build,
	deploy: deployCmd.deploy,
	deployStakingRewards: deployStakingRewardsCmd.deployStakingRewards,
	deployShortingRewards: deployShortingRewardsCmd.deployShortingRewards,
	replaceTribes: require('../../publish/src/commands/replace-tribes').replaceTribes,
	purgeTribes: require('../../publish/src/commands/purge-tribes').purgeTribes,
	removeTribes: require('../../publish/src/commands/remove-tribes').removeTribes,
};

const snx = require('../..');
const {
	toBytes32,
	constants: {
		STAKING_REWARDS_FILENAME,
		CONFIG_FILENAME,
		DEPLOYMENT_FILENAME,
		TRIBEONES_FILENAME,
		FEEDS_FILENAME,
	},
	defaults: {
		WAITING_PERIOD_SECS,
		PRICE_DEVIATION_THRESHOLD_FACTOR,
		ISSUANCE_RATIO,
		FEE_PERIOD_DURATION,
		TARGET_THRESHOLD,
		LIQUIDATION_DELAY,
		LIQUIDATION_RATIO,
		HAKA_LIQUIDATION_PENALTY,
		RATE_STALE_PERIOD,
		MINIMUM_STAKE_TIME,
		TRADING_REWARDS_ENABLED,
		DEBT_SNAPSHOT_STALE_TIME,
		ATOMIC_MAX_VOLUME_PER_BLOCK,
		ATOMIC_TWAP_WINDOW,
	},
	wrap,
} = snx;

const concurrency = isCI ? 1 : 10;
const limitPromise = pLimit(concurrency);

describe('publish scripts', () => {
	const network = 'local';

	const {
		getSource,
		getTarget,
		getTribes,
		getPathToNetwork,
		getStakingRewards,
		getShortingRewards,
	} = wrap({
		network,
		fs,
		path,
	});

	const deploymentPath = getPathToNetwork();

	// track these files to revert them later on
	const rewardsJSONPath = path.join(deploymentPath, STAKING_REWARDS_FILENAME);
	const rewardsJSON = fs.readFileSync(rewardsJSONPath);
	const tribesJSONPath = path.join(deploymentPath, TRIBEONES_FILENAME);
	const tribesJSON = fs.readFileSync(tribesJSONPath);
	const configJSONPath = path.join(deploymentPath, CONFIG_FILENAME);
	const configJSON = fs.readFileSync(configJSONPath);
	const deploymentJSONPath = path.join(deploymentPath, DEPLOYMENT_FILENAME);
	const feedsJSONPath = path.join(deploymentPath, FEEDS_FILENAME);
	const feedsJSON = fs.readFileSync(feedsJSONPath);

	const logfilePath = path.join(__dirname, 'test.log');
	let gasLimit;
	let gasPrice;
	let accounts;
	let hUSD;
	let hBTC;
	let hETH;
	let provider;
	let overrides;
	let MockAggregatorFactory;

	const resetConfigAndTribeFiles = () => {
		// restore the tribes and config files for this env (cause removal updated it)
		fs.writeFileSync(tribesJSONPath, tribesJSON);
		fs.writeFileSync(rewardsJSONPath, rewardsJSON);
		fs.writeFileSync(configJSONPath, configJSON);
		fs.writeFileSync(feedsJSONPath, feedsJSON);

		// and reset the deployment.json to signify new deploy
		fs.writeFileSync(deploymentJSONPath, JSON.stringify({ targets: {}, sources: {} }));
	};

	const callMethodWithRetry = async method => {
		let response;

		try {
			response = await method;
		} catch (err) {
			console.log('Error detected looking up value. Ignoring and trying again.', err);
			// retry
			response = await method;
		}

		return limitPromise(() => response);
	};

	before(() => {
		fs.writeFileSync(logfilePath, ''); // reset log file
		fs.writeFileSync(deploymentJSONPath, JSON.stringify({ targets: {}, sources: {} }));
	});

	beforeEach(async () => {
		console.log = (...input) => fs.appendFileSync(logfilePath, input.join(' ') + '\n');

		provider = new ethers.providers.JsonRpcProvider({
			url: 'https://sepolia.blast.io',
		});

		const { isCompileRequired, createMockAggregatorFactory } = testUtils();

		// load accounts used by local EVM
		const wallets = loadLocalWallets({ provider });

		accounts = {
			deployer: wallets[0],
			first: wallets[1],
			second: wallets[2],
		};

		if (isCompileRequired()) {
			console.log('Found source file modified after build. Rebuilding...');

			await commands.build({ showContractSize: true, testHelpers: true });
		} else {
			console.log('Skipping build as everything up to date');
		}

		MockAggregatorFactory = await createMockAggregatorFactory(accounts.deployer);

		[hUSD, hBTC, hETH] = ['hUSD', 'hBTC', 'hETH'].map(toBytes32);

		gasLimit = 8000000;
		gasPrice = ethers.utils.parseUnits('5', 'gwei');

		overrides = {
			gasLimit,
			gasPrice,
		};
	});

	afterEach(resetConfigAndTribeFiles);

	describe('integrated actions test', () => {
		describe('when deployed', () => {
			let rewards;
			let sources;
			let targets;
			let tribes;
			let Tribeone;
			let timestamp;
			let hUSDContract;
			let hBTCContract;
			let hETHContract;
			let FeePool;
			let DebtCache;
			let Exchanger;
			let Issuer;
			let SystemSettings;
			let Liquidator;
			let ExchangeRates;
			const aggregators = {};

			const getContract = ({ target, source }) =>
				new ethers.Contract(
					targets[target].address,
					(sources[source] || sources[targets[target].source]).abi,
					accounts.deployer
				);

			const createMockAggregator = async () => {
				const MockAggregator = await MockAggregatorFactory.deploy({ gasLimit, gasPrice });

				const tx = await MockAggregator.setDecimals('8', {
					gasLimit,
					gasPrice,
				});
				await tx.wait();

				return MockAggregator;
			};

			const setAggregatorAnswer = async ({ asset, rate }) => {
				let tx;

				tx = await aggregators[asset].setLatestAnswer(
					(rate * 1e8).toString(),
					timestamp,
					overrides
				);
				await tx.wait();

				// Cache the debt to make sure nothing's wrong/stale after the rate update.
				tx = await DebtCache.takeDebtSnapshot(overrides);
			};

			beforeEach(async () => {
				timestamp = (await provider.getBlock(await provider.getBlockNumber())).timestamp;

				// deploy a mock aggregator for all supported rates
				const feeds = JSON.parse(feedsJSON);
				for (const feedEntry of Object.values(feeds)) {
					const aggregator = await createMockAggregator();
					aggregators[feedEntry.asset] = aggregator;
					feedEntry.feed = aggregator.address;
				}
				fs.writeFileSync(feedsJSONPath, JSON.stringify(feeds));

				await commands.deploy({
					concurrency,
					network,
					freshDeploy: true,
					includeFutures: false,
					includePerpsV2: false,
					yes: true,
					privateKey: accounts.deployer.privateKey,
					ignoreCustomParameters: true,
				});

				sources = getSource();
				targets = getTarget();
				tribes = getTribes().filter(({ name }) => name !== 'hUSD');

				Tribeone = getContract({ target: 'ProxyTribeone', source: 'Tribeone' });
				FeePool = getContract({ target: 'ProxyFeePool', source: 'FeePool' });
				Exchanger = getContract({ target: 'Exchanger' });
				DebtCache = getContract({ target: 'DebtCache' });

				Issuer = getContract({ target: 'Issuer' });

				hUSDContract = getContract({ target: 'ProxyhUSD', source: 'Tribe' });

				hBTCContract = getContract({ target: 'ProxyhBTC', source: 'Tribe' });
				hETHContract = getContract({ target: 'ProxyhETH', source: 'Tribe' });
				SystemSettings = getContract({ target: 'SystemSettings' });

				Liquidator = getContract({ target: 'Liquidator' });

				ExchangeRates = getContract({ target: 'ExchangeRates' });
			});

			describe('default system settings', () => {
				it('defaults are properly configured in a fresh deploy', async () => {
					assert.strictEqual((await Exchanger.waitingPeriodSecs()).toString(), WAITING_PERIOD_SECS);
					assert.strictEqual(
						(await Exchanger.priceDeviationThresholdFactor()).toString(),
						PRICE_DEVIATION_THRESHOLD_FACTOR
					);
					assert.strictEqual(await Exchanger.tradingRewardsEnabled(), TRADING_REWARDS_ENABLED);
					assert.strictEqual(
						(await Exchanger.atomicMaxVolumePerBlock()).toString(),
						ATOMIC_MAX_VOLUME_PER_BLOCK
					);
					assert.strictEqual((await Issuer.issuanceRatio()).toString(), ISSUANCE_RATIO);
					assert.strictEqual((await FeePool.feePeriodDuration()).toString(), FEE_PERIOD_DURATION);
					assert.strictEqual(
						(await FeePool.targetThreshold()).toString(),
						ethers.utils.parseEther((TARGET_THRESHOLD / 100).toString()).toString()
					);

					assert.strictEqual((await Liquidator.liquidationDelay()).toString(), LIQUIDATION_DELAY);
					assert.strictEqual((await Liquidator.liquidationRatio()).toString(), LIQUIDATION_RATIO);
					assert.strictEqual(
						(await SystemSettings.snxLiquidationPenalty()).toString(),
						HAKA_LIQUIDATION_PENALTY
					);
					assert.strictEqual((await ExchangeRates.rateStalePeriod()).toString(), RATE_STALE_PERIOD);
					assert.strictEqual(
						(await SystemSettings.atomicTwapWindow()).toString(),
						ATOMIC_TWAP_WINDOW
					);
					assert.strictEqual(
						(await DebtCache.debtSnapshotStaleTime()).toString(),
						DEBT_SNAPSHOT_STALE_TIME
					);
					assert.strictEqual((await Issuer.minimumStakeTime()).toString(), MINIMUM_STAKE_TIME);
				});

				describe('when defaults are changed', () => {
					let newWaitingPeriod;
					let newPriceDeviation;
					let newAtomicMaxVolumePerBlock;
					let newIssuanceRatio;
					let newFeePeriodDuration;
					let newTargetThreshold;
					let newLiquidationsDelay;
					let newLiquidationsRatio;
					let newLiquidationsPenalty;
					let newSnxLiquidationsPenalty;
					let newRateStalePeriod;
					let newAtomicTwapWindow;
					let newRateForhUSD;
					let newMinimumStakeTime;
					let newDebtSnapshotStaleTime;

					beforeEach(async () => {
						newWaitingPeriod = '10';
						newPriceDeviation = ethers.utils.parseEther('0.45').toString();
						newAtomicMaxVolumePerBlock = ethers.utils.parseEther('1000').toString();
						newIssuanceRatio = ethers.utils.parseEther('0.25').toString();
						newFeePeriodDuration = (3600 * 24 * 3).toString(); // 3 days
						newTargetThreshold = '6';
						newLiquidationsDelay = newFeePeriodDuration;
						newLiquidationsRatio = ethers.utils.parseEther('0.6').toString(); // must be above newIssuanceRatio * 2
						newLiquidationsPenalty = ethers.utils.parseEther('0.25').toString();
						newSnxLiquidationsPenalty = ethers.utils.parseEther('0.25').toString();
						newRateStalePeriod = '3400';
						newAtomicTwapWindow = '1800';
						newRateForhUSD = ethers.utils.parseEther('0.1').toString();
						newMinimumStakeTime = '3999';
						newDebtSnapshotStaleTime = '43200'; // Half a day

						let tx;

						tx = await SystemSettings.setWaitingPeriodSecs(newWaitingPeriod, overrides);
						await tx.wait();

						tx = await SystemSettings.setPriceDeviationThresholdFactor(
							newPriceDeviation,
							overrides
						);
						await tx.wait();

						tx = await SystemSettings.setAtomicMaxVolumePerBlock(
							newAtomicMaxVolumePerBlock,
							overrides
						);
						await tx.wait();

						tx = await SystemSettings.setIssuanceRatio(newIssuanceRatio, overrides);
						await tx.wait();

						tx = await SystemSettings.setFeePeriodDuration(newFeePeriodDuration, overrides);
						await tx.wait();

						tx = await SystemSettings.setTargetThreshold(newTargetThreshold, overrides);
						await tx.wait();

						tx = await SystemSettings.setLiquidationDelay(newLiquidationsDelay, overrides);
						await tx.wait();

						tx = await SystemSettings.setLiquidationRatio(newLiquidationsRatio, overrides);
						await tx.wait();

						tx = await SystemSettings.setSnxLiquidationPenalty(
							newSnxLiquidationsPenalty,
							overrides
						);
						await tx.wait();

						tx = await SystemSettings.setLiquidationPenalty(newLiquidationsPenalty, overrides);
						await tx.wait();

						tx = await SystemSettings.setAtomicTwapWindow(newAtomicTwapWindow, overrides);
						await tx.wait();

						tx = await SystemSettings.setRateStalePeriod(newRateStalePeriod, overrides);
						await tx.wait();

						tx = await SystemSettings.setDebtSnapshotStaleTime(newDebtSnapshotStaleTime, overrides);
						await tx.wait();

						tx = await SystemSettings.setMinimumStakeTime(newMinimumStakeTime, overrides);
						await tx.wait();

						tx = await SystemSettings.setExchangeFeeRateForTribes(
							[toBytes32('hUSD')],
							[newRateForhUSD],
							overrides
						);
						await tx.wait();
					});
					describe('when redeployed with a new system settings contract', () => {
						beforeEach(async () => {
							// read current config file version (if something has been removed,
							// we don't want to include it here)
							const currentConfigFile = JSON.parse(fs.readFileSync(configJSONPath));
							const configForExrates = Object.keys(currentConfigFile).reduce((memo, cur) => {
								memo[cur] = { deploy: cur === 'SystemSettings' };
								return memo;
							}, {});

							fs.writeFileSync(configJSONPath, JSON.stringify(configForExrates));

							await commands.deploy({
								concurrency,
								network,
								yes: true,
								includeFutures: false,
								includePerpsV2: false,
								privateKey: accounts.deployer.privateKey,
							});
						});
						it('then the defaults remain unchanged', async () => {
							assert.strictEqual(
								(await Exchanger.waitingPeriodSecs()).toString(),
								newWaitingPeriod
							);
							assert.strictEqual(
								(await Exchanger.priceDeviationThresholdFactor()).toString(),
								newPriceDeviation
							);
							assert.strictEqual(
								(await Exchanger.atomicMaxVolumePerBlock()).toString(),
								newAtomicMaxVolumePerBlock
							);
							assert.strictEqual((await Issuer.issuanceRatio()).toString(), newIssuanceRatio);
							assert.strictEqual(
								(await FeePool.feePeriodDuration()).toString(),
								newFeePeriodDuration
							);
							assert.strictEqual(
								(await FeePool.targetThreshold()).toString(),
								ethers.utils.parseEther((newTargetThreshold / 100).toString()).toString()
							);
							assert.strictEqual(
								(await Liquidator.liquidationDelay()).toString(),
								newLiquidationsDelay
							);
							assert.strictEqual(
								(await Liquidator.liquidationRatio()).toString(),
								newLiquidationsRatio
							);
							assert.strictEqual(
								(await SystemSettings.snxLiquidationPenalty()).toString(),
								newSnxLiquidationsPenalty
							);
							assert.strictEqual(
								(await ExchangeRates.rateStalePeriod()).toString(),
								newRateStalePeriod
							);
							assert.strictEqual(
								(await SystemSettings.atomicTwapWindow()).toString(),
								newAtomicTwapWindow
							);
							assert.strictEqual((await Issuer.minimumStakeTime()).toString(), newMinimumStakeTime);
							assert.strictEqual(
								(
									await Exchanger.feeRateForExchange(toBytes32('(ignored)'), toBytes32('hUSD'))
								).toString(),
								newRateForhUSD
							);
						});
					});
				});
			});

			describe('tribes added to Issuer', () => {
				const hexToString = hex => ethers.utils.toUtf8String(hex).replace(/\0/g, '');

				it('then all tribes are added to the issuer', async () => {
					const keys = await Issuer.availableCurrencyKeys();
					assert.deepStrictEqual(
						keys.map(hexToString),
						JSON.parse(tribesJSON).map(({ name }) => name)
					);
				});
				describe('when only hUSD and hETH is chosen as a tribe', () => {
					beforeEach(async () => {
						fs.writeFileSync(
							tribesJSONPath,
							JSON.stringify([
								{ name: 'hUSD', asset: 'USD' },
								{ name: 'hETH', asset: 'ETH' },
							])
						);
					});
					describe('when Issuer redeployed', () => {
						beforeEach(async () => {
							const currentConfigFile = JSON.parse(fs.readFileSync(configJSONPath));
							const configForExrates = Object.keys(currentConfigFile).reduce((memo, cur) => {
								memo[cur] = { deploy: cur === 'Issuer' };
								return memo;
							}, {});

							fs.writeFileSync(configJSONPath, JSON.stringify(configForExrates));

							await commands.deploy({
								concurrency,
								addNewTribes: true,
								network,
								yes: true,
								includeFutures: false,
								includePerpsV2: false,
								privateKey: accounts.deployer.privateKey,
							});
							targets = getTarget();
							Issuer = getContract({ target: 'Issuer' });
						});
						it('then only hUSD is added to the issuer', async () => {
							const keys = await Issuer.availableCurrencyKeys();
							assert.deepStrictEqual(keys.map(hexToString), ['hUSD', 'hETH']);
						});
					});
				});
			});
			describe('deploy-staking-rewards', () => {
				beforeEach(async () => {
					const rewardsToDeploy = [
						'hETHUniswapV1',
						'sXAUUniswapV2',
						'hUSDCurve',
						'iETH',
						'iETH2',
						'iETH3',
						'iBTC',
						'HAKABalancer',
					];

					await commands.deployStakingRewards({
						network,
						yes: true,
						privateKey: accounts.deployer.privateKey,
						rewardsToDeploy,
					});

					rewards = getStakingRewards();
					sources = getSource();
					targets = getTarget();
				});

				it('script works as intended', async () => {
					for (const { name, stakingToken, rewardsToken } of rewards) {
						const stakingRewardsName = `StakingRewards${name}`;
						const stakingRewardsContract = getContract({ target: stakingRewardsName });

						// Test staking / rewards token address
						const tokens = [
							{ token: stakingToken, method: 'stakingToken' },
							{ token: rewardsToken, method: 'rewardsToken' },
						];

						for (const { token, method } of tokens) {
							const tokenAddress = await stakingRewardsContract[method]();

							if (ethers.utils.isAddress(token)) {
								assert.strictEqual(token.toLowerCase(), tokenAddress.toLowerCase());
							} else {
								assert.strictEqual(
									tokenAddress.toLowerCase(),
									targets[token].address.toLowerCase()
								);
							}
						}

						// Test rewards distribution address
						const rewardsDistributionAddress = await stakingRewardsContract.rewardsDistribution();
						assert.strictEqual(
							rewardsDistributionAddress.toLowerCase(),
							targets['RewardsDistribution'].address.toLowerCase()
						);
					}
				});
			});

			describe('deploy-shorting-rewards', () => {
				beforeEach(async () => {
					const rewardsToDeploy = ['hBTC', 'hETH'];

					await commands.deployShortingRewards({
						network,
						yes: true,
						privateKey: accounts.deployer.privateKey,
						rewardsToDeploy,
					});

					rewards = getShortingRewards();
					sources = getSource();
					targets = getTarget();
				});

				it('script works as intended', async () => {
					for (const { name, rewardsToken } of rewards) {
						const shortingRewardsName = `ShortingRewards${name}`;
						const shortingRewardsContract = getContract({ target: shortingRewardsName });

						const tokenAddress = await shortingRewardsContract.rewardsToken();

						if (ethers.utils.isAddress(rewardsToken)) {
							assert.strictEqual(rewardsToken.toLowerCase(), tokenAddress.toLowerCase());
						} else {
							assert.strictEqual(
								tokenAddress.toLowerCase(),
								targets[rewardsToken].address.toLowerCase()
							);
						}

						// Test rewards distribution address should be the deployer, since we are
						// funding by the sDAO for the trial.
						const rewardsDistributionAddress = await shortingRewardsContract.rewardsDistribution();
						assert.strictEqual(
							rewardsDistributionAddress.toLowerCase(),
							accounts.deployer.address.toLowerCase()
						);
					}
				});
			});

			describe('importFeePeriods', () => {
				let feePeriodLength;

				beforeEach(async () => {
					feePeriodLength = await callMethodWithRetry(FeePool.FEE_PERIOD_LENGTH());
				});

				const daysAgo = days => Math.round(Date.now() / 1000 - 3600 * 24 * days);

				const redeployFeePeriodOnly = async function() {
					// read current config file version (if something has been removed,
					// we don't want to include it here)
					const currentConfigFile = JSON.parse(fs.readFileSync(configJSONPath));
					const configForExrates = Object.keys(currentConfigFile).reduce((memo, cur) => {
						memo[cur] = { deploy: cur === 'FeePool' };
						return memo;
					}, {});

					fs.writeFileSync(configJSONPath, JSON.stringify(configForExrates));

					await commands.deploy({
						concurrency,
						network,
						yes: true,
						includeFutures: false,
						includePerpsV2: false,
						privateKey: accounts.deployer.privateKey,
					});
				};

				describe('when FeePool is given three true imported periods', () => {
					let periodsAdded;
					beforeEach(async () => {
						periodsAdded = [];
						const addPeriod = (feePeriodId, startTime) => {
							periodsAdded.push([`${startTime}`, '0', `${startTime}`, '3', '4', '5', '6']);
						};
						for (let i = 0; i < feePeriodLength; i++) {
							const startTime = daysAgo((i + 1) * 6);
							addPeriod((i + 1).toString(), startTime.toString());

							const tx = await FeePool.importFeePeriod(
								i,
								startTime,
								startTime,
								3,
								4,
								5,
								6,
								overrides
							);
							await tx.wait();
						}
					});

					describe('when the system is suspended', () => {
						beforeEach(async () => {
							await getContract({ target: 'SystemStatus' }).suspendSystem('1', {
								from: accounts.deployer.address,
							});
						});
						describe('when FeePool alone is redeployed', () => {
							beforeEach(redeployFeePeriodOnly);
							describe('using the FeePoolNew', () => {
								let FeePoolNew;
								beforeEach(async () => {
									targets = getTarget();
									FeePoolNew = getContract({ target: 'FeePool' });
								});

								it('then the periods are added correctly', async () => {
									let periods = await Promise.all(
										[0, 1].map(i => callMethodWithRetry(FeePoolNew.recentFeePeriods(i)))
									);
									// strip index props off the returned object
									periods.forEach(period =>
										Object.keys(period)
											.filter(key => /^[0-9]+$/.test(key))
											.forEach(key => delete period[key])
									);

									periods = periods.map(period => period.map(bn => bn.toString()));

									assert.strictEqual(JSON.stringify(periods[0]), JSON.stringify(periodsAdded[0]));
									assert.strictEqual(JSON.stringify(periods[1]), JSON.stringify(periodsAdded[1]));
								});
							});
						});
					});
				});
			});

			describe('when ExchangeRates has prices wHAKA $0.30 and all tribes $1', () => {
				beforeEach(async () => {
					// set default issuance of 0.2
					const tx = await SystemSettings.setIssuanceRatio(
						ethers.utils.parseEther('0.2'),
						overrides
					);
					await tx.wait();

					// make sure exchange rates has prices for specific assets

					const answersToSet = [{ asset: 'wHAKA', rate: 0.3 }].concat(
						tribes.map(({ asset }) => {
							// as the same assets are used for long and shorts, search by asset rather than
							// name (currencyKey) here so that we don't accidentially override an inverse with
							// another rate
							if (asset === 'DEFI') {
								// ensure iDEFI is frozen at the lower limit, by setting the incoming rate
								// above the upper limit
								return {
									asset,
									rate: 9999999999,
								};
							} else if (asset === 'TRX') {
								// ensure iTRX is frozen at the upper limit, by setting the incoming rate
								// below the lower limit
								return {
									asset,
									rate: 0.000001,
								};
							} else if (asset === 'XTZ') {
								// ensure iXTZ is frozen at upper limit
								return {
									asset,
									rate: 0.000001,
								};
							} else if (asset === 'CEX') {
								// ensure iCEX is frozen at lower limit
								return {
									asset,
									rate: 9999999999,
								};
							}
							return {
								asset,
								rate: 1,
							};
						})
					);

					for (const { asset, rate } of answersToSet) {
						await setAggregatorAnswer({ asset, rate });
					}
				});

				describe('when transferring 100k wHAKA to user1', () => {
					beforeEach(async () => {
						// transfer wHAKA to first account
						const tx = await Tribeone.transfer(
							accounts.first.address,
							ethers.utils.parseEther('100000'),
							overrides
						);
						await tx.wait();
					});

					describe('when user1 issues all possible hUSD', () => {
						beforeEach(async () => {
							Tribeone = Tribeone.connect(accounts.first);

							const tx = await Tribeone.issueMaxTribes(overrides);
							await tx.wait();
						});
						it('then the hUSD balanced must be 100k * 0.3 * 0.2 (default SystemSettings.issuanceRatio) = 6000', async () => {
							const balance = await callMethodWithRetry(
								hUSDContract.balanceOf(accounts.first.address)
							);
							assert.strictEqual(
								ethers.utils.formatEther(balance.toString()),
								'6000.0',
								'Balance should match'
							);
						});
						describe('when user1 exchange 1000 hUSD for hETH (the MultiCollateralTribe)', () => {
							let hETHBalanceAfterExchange;
							beforeEach(async () => {
								await Tribeone.exchange(hUSD, ethers.utils.parseEther('1000'), hETH, overrides);
								hETHBalanceAfterExchange = await callMethodWithRetry(
									hETHContract.balanceOf(accounts.first.address)
								);
							});
							it('then their hUSD balance is 5000', async () => {
								const balance = await callMethodWithRetry(
									hUSDContract.balanceOf(accounts.first.address)
								);
								assert.strictEqual(
									ethers.utils.formatEther(balance.toString()),
									'5000.0',
									'Balance should match'
								);
							});
							it('and their hETH balance is 1000 - the fee', async () => {
								const { amountReceived } = await callMethodWithRetry(
									Exchanger.getAmountsForExchange(ethers.utils.parseEther('1000'), hUSD, hETH)
								);
								assert.strictEqual(
									ethers.utils.formatEther(hETHBalanceAfterExchange.toString()),
									ethers.utils.formatEther(amountReceived.toString()),
									'Balance should match'
								);
							});

							describe('tribe suspension', () => {
								let CircuitBreaker;
								describe('when one tribe has a price well outside of range, triggering price deviation', () => {
									beforeEach(async () => {
										CircuitBreaker = getContract({ target: 'CircuitBreaker' });
										await setAggregatorAnswer({ asset: 'ETH', rate: 20 });
									});
									it('when exchange occurs into that tribe, the tribe is suspended', async () => {
										const tx = await Tribeone.exchange(
											hUSD,
											ethers.utils.parseEther('1'),
											hETH,
											overrides
										);
										await tx.wait();

										const suspended = await CircuitBreaker.circuitBroken(
											aggregators['ETH'].address
										);
										assert.strictEqual(suspended, true);
									});
								});
							});
						});
						describe('when user1 exchange 1000 hUSD for hBTC', () => {
							let hBTCBalanceAfterExchange;
							beforeEach(async () => {
								const tx = await Tribeone.exchange(
									hUSD,
									ethers.utils.parseEther('1000'),
									hBTC,
									overrides
								);
								await tx.wait();
								hBTCBalanceAfterExchange = await callMethodWithRetry(
									hBTCContract.balanceOf(accounts.first.address)
								);
							});
							it('then their hUSD balance is 5000', async () => {
								const balance = await callMethodWithRetry(
									hUSDContract.balanceOf(accounts.first.address)
								);
								assert.strictEqual(
									ethers.utils.formatEther(balance.toString()),
									'5000.0',
									'Balance should match'
								);
							});
							it('and their hBTC balance is 1000 - the fee', async () => {
								const { amountReceived } = await callMethodWithRetry(
									Exchanger.getAmountsForExchange(ethers.utils.parseEther('1000'), hUSD, hBTC)
								);
								assert.strictEqual(
									ethers.utils.formatEther(hBTCBalanceAfterExchange.toString()),
									ethers.utils.formatEther(amountReceived.toString()),
									'Balance should match'
								);
							});
							describe('when user1 burns 10 hUSD', () => {
								beforeEach(async () => {
									let tx;

									// set minimumStakeTime to 0 seconds for burning
									tx = await SystemSettings.setMinimumStakeTime(0, overrides);
									await tx.wait();

									// burn
									tx = await Tribeone.burnTribes(ethers.utils.parseEther('10'), overrides);
									await tx.wait();
								});
								it('then their hUSD balance is 4990', async () => {
									const balance = await callMethodWithRetry(
										hUSDContract.balanceOf(accounts.first.address)
									);
									assert.strictEqual(
										ethers.utils.formatEther(balance.toString()),
										'4990.0',
										'Balance should match'
									);
								});

								describe('when deployer replaces hBTC with PurgeableTribe', () => {
									beforeEach(async () => {
										await commands.replaceTribes({
											network,
											yes: true,
											privateKey: accounts.deployer.privateKey,
											subclass: 'PurgeableTribe',
											tribesToReplace: ['hBTC'],
											methodCallGasLimit: gasLimit,
										});
									});
									describe('and deployer invokes purge', () => {
										beforeEach(async () => {
											await fastForward({ seconds: 500, provider }); // fast forward through waiting period

											await commands.purgeTribes({
												network,
												yes: true,
												privateKey: accounts.deployer.privateKey,
												addresses: [accounts.first.address],
												tribesToPurge: ['hBTC'],
												gasLimit,
											});
										});
										it('then their hUSD balance is 4990 + hBTCBalanceAfterExchange', async () => {
											const balance = await callMethodWithRetry(
												hUSDContract.balanceOf(accounts.first.address)
											);
											const [amountReceived] = await callMethodWithRetry(
												Exchanger.getAmountsForExchange(hBTCBalanceAfterExchange, hBTC, hUSD)
											);
											assert.strictEqual(
												ethers.utils.formatEther(balance.toString()),
												(4990 + +ethers.utils.formatEther(amountReceived.toString())).toString(),
												'Balance should match'
											);
										});
										it('and their hBTC balance is 0', async () => {
											const balance = await callMethodWithRetry(
												hBTCContract.balanceOf(accounts.first.address)
											);
											assert.strictEqual(
												ethers.utils.formatEther(balance.toString()),
												'0.0',
												'Balance should match'
											);
										});
									});
								});
							});
						});
					});
				});
			});

			describe('when a pricing aggregator exists', () => {
				let mockAggregator;
				beforeEach(async () => {
					mockAggregator = await createMockAggregator();
				});
				describe('when Tribeone.anyTribeOrHAKARateIsInvalid() is invoked', () => {
					it('then it returns true as expected', async () => {
						const response = await Tribeone.anyTribeOrHAKARateIsInvalid();
						assert.strictEqual(response, true, 'anyTribeOrHAKARateIsInvalid must be true');
					});
				});
				describe('when one tribe is configured to have a pricing aggregator', () => {
					beforeEach(async () => {
						const currentFeeds = JSON.parse(fs.readFileSync(feedsJSONPath));

						// mutate parameters of EUR - instructing it to use the mock aggregator as a feed
						currentFeeds['BTC'].feed = mockAggregator.address;

						fs.writeFileSync(feedsJSONPath, JSON.stringify(currentFeeds));
					});
					describe('when a deployment with nothing set to deploy fresh is run', () => {
						let ExchangeRates;
						beforeEach(async () => {
							const currentConfigFile = JSON.parse(fs.readFileSync(configJSONPath));
							const configForExrates = Object.keys(currentConfigFile).reduce((memo, cur) => {
								memo[cur] = { deploy: false };
								return memo;
							}, {});

							fs.writeFileSync(configJSONPath, JSON.stringify(configForExrates));

							await commands.deploy({
								concurrency,
								network,
								yes: true,
								includeFutures: false,
								includePerpsV2: false,
								privateKey: accounts.deployer.privateKey,
							});
							targets = getTarget();

							ExchangeRates = getContract({ target: 'ExchangeRates' });
						});
						it('then the aggregator must be set for the hBTC price', async () => {
							const aggregator = await callMethodWithRetry(
								ExchangeRates.aggregators(toBytes32('hBTC'))
							);
							assert.strictEqual(aggregator, mockAggregator.address);
						});

						describe('when ExchangeRates has rates for all tribes except the aggregated tribe hBTC', () => {
							beforeEach(async () => {
								// update rates
								const tribesToUpdate = tribes
									.filter(({ name }) => name !== 'hBTC')
									.concat({ asset: 'wHAKA', rate: 1 });

								for (const { asset } of tribesToUpdate) {
									await setAggregatorAnswer({ asset, rate: 1 });
								}
							});
							describe('when Tribeone.anyTribeOrHAKARateIsInvalid() is invoked', () => {
								it('then it returns true as hBTC still is', async () => {
									const response = await Tribeone.anyTribeOrHAKARateIsInvalid();
									assert.strictEqual(response, true, 'anyTribeOrHAKARateIsInvalid must be true');
								});
							});

							describe('when the aggregator has a price', () => {
								const rate = '1.15';
								let newTs;
								beforeEach(async () => {
									newTs = timestamp + 300;
									const tx = await mockAggregator.setLatestAnswer(
										(rate * 1e8).toFixed(0),
										newTs,
										overrides
									);
									await tx.wait();
								});
								describe('then the price from exchange rates for that currency key uses the aggregator', () => {
									it('correctly returns the rate', async () => {
										const response = await callMethodWithRetry(
											ExchangeRates.rateForCurrency(toBytes32('hBTC'))
										);
										assert.strictEqual(ethers.utils.formatEther(response.toString()), rate);
									});
								});

								describe('when Tribeone.anyTribeOrHAKARateIsInvalid() is invoked', () => {
									it('then it returns false as expected', async () => {
										const response = await Tribeone.anyTribeOrHAKARateIsInvalid();
										assert.strictEqual(response, false, 'anyTribeOrHAKARateIsInvalid must be false');
									});
								});
							});
						});
					});
				});
			});

			describe('AddressResolver consolidation', () => {
				let ReadProxyAddressResolver;
				beforeEach(async () => {
					ReadProxyAddressResolver = getContract({ target: 'ReadProxyAddressResolver' });
				});
				describe('when the AddressResolver is set to deploy and everything else false', () => {
					beforeEach(async () => {
						const currentConfigFile = JSON.parse(fs.readFileSync(configJSONPath));
						const configForAddressResolver = Object.keys(currentConfigFile).reduce((memo, cur) => {
							memo[cur] = { deploy: cur === 'AddressResolver' };
							return memo;
						}, {});

						fs.writeFileSync(configJSONPath, JSON.stringify(configForAddressResolver));
					});
					describe('when re-deployed', () => {
						let AddressResolver;
						beforeEach(async () => {
							await commands.deploy({
								concurrency,
								network,
								yes: true,
								includeFutures: false,
								includePerpsV2: false,
								privateKey: accounts.deployer.privateKey,
							});
							targets = getTarget();

							AddressResolver = getContract({ target: 'AddressResolver' });
						});
						it('then the read proxy address resolver is updated', async () => {
							assert.strictEqual(await ReadProxyAddressResolver.target(), AddressResolver.address);
						});
						it('and the resolver has all the addresses inside', async () => {
							const targets = getTarget();

							const responses = await Promise.all(
								[
									'DebtCache',
									'DelegateApprovals',
									'Depot',
									'Exchanger',
									'ExchangeRates',
									'ExchangeState',
									'FeePool',
									'FeePoolEternalStorage',
									'Issuer',
									'Liquidator',
									'RewardEscrow',
									'RewardsDistribution',
									'SupplySchedule',
									'Tribeone',
									'TribeoneDebtShare',
									'TribeoneEscrow',
									'TribehETH',
									'TribehUSD',
									'SystemStatus',
								].map(contractName =>
									callMethodWithRetry(
										AddressResolver.getAddress(snx.toBytes32(contractName))
									).then(found => ({ contractName, ok: found === targets[contractName].address }))
								)
							);

							for (const { contractName, ok } of responses) {
								assert.ok(ok, `${contractName} incorrect in resolver`);
							}
						});
					});
				});
				describe('when Exchanger is marked to deploy, and everything else false', () => {
					beforeEach(async () => {
						const currentConfigFile = JSON.parse(fs.readFileSync(configJSONPath));
						const configForExchanger = Object.keys(currentConfigFile).reduce((memo, cur) => {
							memo[cur] = { deploy: cur === 'Exchanger' };
							return memo;
						}, {});

						fs.writeFileSync(configJSONPath, JSON.stringify(configForExchanger));
					});
					describe('when re-deployed', () => {
						let AddressResolver;
						beforeEach(async () => {
							AddressResolver = getContract({ target: 'AddressResolver' });

							const existingExchanger = await callMethodWithRetry(
								AddressResolver.getAddress(snx.toBytes32('Exchanger'))
							);

							assert.strictEqual(existingExchanger, targets['Exchanger'].address);

							await commands.deploy({
								concurrency,
								network,
								yes: true,
								includeFutures: false,
								includePerpsV2: false,
								privateKey: accounts.deployer.privateKey,
							});
						});
						it('then the address resolver has the new Exchanger added to it', async () => {
							const targets = getTarget();

							const actualExchanger = await callMethodWithRetry(
								AddressResolver.getAddress(snx.toBytes32('Exchanger'))
							);

							assert.strictEqual(actualExchanger, targets['Exchanger'].address);
						});
						it('and all have resolver cached correctly', async () => {
							const targets = getTarget();

							const contractsWithResolver = await Promise.all(
								Object.entries(targets)
									// Note: TribeoneBridgeToOptimism and TribeoneBridgeToBase  have ':' in their deps, instead of hardcoding the
									// address here we should look up all required contracts and ignore any that have
									// ':' in it
									.filter(([contract]) => !/^TribeoneBridge/.test(contract))
									// Same applies to the owner relays
									.filter(([contract]) => !/^OwnerRelay/.test(contract))
									// Same applies to the debt migrators
									.filter(([contract]) => !/^DebtMigrator/.test(contract))
									// same for external contracts
									.filter(([contract]) => !/^ext:/.test(contract))
									// remove debt oracles
									.filter(([contract]) => !/^OneNet/.test(contract))
									// Note: the VirtualTribe mastercopy is null-initialized and shouldn't be checked
									.filter(([contract]) => !/^VirtualTribeMastercopy/.test(contract))
									.filter(([, { source }]) =>
										sources[source].abi.find(({ name }) => name === 'resolver')
									)
									.map(([contract, { source, address }]) => {
										const Contract = new ethers.Contract(address, sources[source].abi, provider);
										return { contract, Contract };
									})
							);

							const readProxyAddress = ReadProxyAddressResolver.address;

							for (const { contract, Contract } of contractsWithResolver) {
								const isCached = await callMethodWithRetry(Contract.isResolverCached());
								assert.ok(isCached, `${contract}.isResolverCached() is false!`);
								assert.strictEqual(
									await callMethodWithRetry(Contract.resolver()),
									readProxyAddress,
									`${contract}.resolver is not the ReadProxyAddressResolver`
								);
							}
						});
					});
				});
			});
		});
	});
});
