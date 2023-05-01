'use strict';

const { artifacts, contract, web3 } = require('hardhat');

const { assert } = require('../contracts/common');

const {
	ensureOnlyExpectedMutativeFunctions,
	onlyGivenAddressCanInvoke,
	getEventByName,
	buildMinimalProxyCode,
} = require('../contracts/helpers');

const { divideDecimal, multiplyDecimal, toUnit } = require('../utils')();

const { getUsers, toBytes32 } = require('../..');
const { toDecimal } = require('web3-utils');

const { toBN } = web3.utils;

let ExchangerWithFeeRecAlternatives;

contract('ExchangerWithFeeRecAlternatives (unit tests)', async accounts => {
	const [, owner] = accounts;
	const [uUSD, sETH, iETH] = ['uUSD', 'sETH', 'iETH'].map(toBytes32);
	const maxAtomicValuePerBlock = toUnit('1000000');
	const baseFeeRate = toUnit('0.003'); // 30bps
	const overrideFeeRate = toUnit('0.01'); // 100bps
	const amountIn = toUnit('100');

	// ensure all of the behaviors are bound to "this" for sharing test state
	const behaviors = require('./ExchangerWithFeeRecAlternatives.behaviors').call(this, {
		accounts,
	});

	const callAsTribeOne = args => [...args, { from: this.mocks.TribeOne.address }];

	before(async () => {
		ExchangerWithFeeRecAlternatives = artifacts.require('ExchangerWithFeeRecAlternatives');
	});

	it('ensure only known functions are mutative', () => {
		ensureOnlyExpectedMutativeFunctions({
			abi: ExchangerWithFeeRecAlternatives.abi,
			ignoreParents: ['Owned', 'MixinResolver'],
			expected: ['exchange', 'exchangeAtomically', 'settle'],
		});
	});

	describe('when a contract is instantiated', () => {
		behaviors.whenInstantiated({ owner }, () => {
			describe('atomicMaxVolumePerBlock()', () => {
				// Mimic setting not being configured
				behaviors.whenMockedWithUintSystemSetting(
					{ setting: 'atomicMaxVolumePerBlock', value: '0' },
					() => {
						it('is set to 0', async () => {
							assert.bnEqual(await this.instance.atomicMaxVolumePerBlock(), '0');
						});
					}
				);

				// With configured value
				behaviors.whenMockedWithUintSystemSetting(
					{ setting: 'atomicMaxVolumePerBlock', value: maxAtomicValuePerBlock },
					() => {
						it('is set to the configured value', async () => {
							assert.bnEqual(await this.instance.atomicMaxVolumePerBlock(), maxAtomicValuePerBlock);
						});
					}
				);
			});

			behaviors.whenMockedWithUintSystemSetting(
				{ setting: 'exchangeMaxDynamicFee', value: toUnit('1') },
				() => {
					describe('feeRateForAtomicExchange()', () => {
						// Mimic settings not being configured
						behaviors.whenMockedWithSynthUintSystemSetting(
							{ setting: 'exchangeFeeRate', synth: sETH, value: '0' },
							() => {
								it('is set to 0', async () => {
									assert.bnEqual(await this.instance.feeRateForAtomicExchange(uUSD, sETH), '0');
								});
							}
						);

						// With configured override value
						behaviors.whenMockedWithSynthUintSystemSetting(
							{ setting: 'atomicExchangeFeeRate', synth: sETH, value: overrideFeeRate },
							() => {
								it('is set to the configured atomic override value', async () => {
									assert.bnEqual(
										await this.instance.feeRateForAtomicExchange(uUSD, sETH),
										overrideFeeRate
									);
								});
							}
						);

						// With configured base and override values
						behaviors.whenMockedWithSynthUintSystemSetting(
							{ setting: 'exchangeFeeRate', synth: sETH, value: baseFeeRate },
							() => {
								it('is set to the configured base value', async () => {
									assert.bnEqual(
										await this.instance.feeRateForAtomicExchange(uUSD, sETH),
										baseFeeRate
									);
								});

								behaviors.whenMockedWithSynthUintSystemSetting(
									{ setting: 'atomicExchangeFeeRate', synth: sETH, value: overrideFeeRate },
									() => {
										it('is set to the configured atomic override value', async () => {
											assert.bnEqual(
												await this.instance.feeRateForAtomicExchange(uUSD, sETH),
												overrideFeeRate
											);
										});
									}
								);
							}
						);
					});
				}
			);

			describe('getAmountsForAtomicExchange()', () => {
				const atomicRate = toUnit('0.01');

				async function assertAmountsReported({ instance, amountIn, atomicRate, feeRate }) {
					const {
						amountReceived,
						fee,
						exchangeFeeRate,
					} = await instance.getAmountsForAtomicExchange(amountIn, uUSD, sETH);
					const expectedAmountReceivedWithoutFees = multiplyDecimal(amountIn, atomicRate);

					assert.bnEqual(amountReceived, expectedAmountReceivedWithoutFees.sub(fee));
					assert.bnEqual(exchangeFeeRate, feeRate);
					assert.bnEqual(multiplyDecimal(amountReceived.add(fee), exchangeFeeRate), fee);
				}

				behaviors.whenMockedEffectiveAtomicRateWithValue(
					{
						atomicRate,
						sourceCurrency: uUSD,
						// These system rates need to be supplied but are ignored in calculating the amount recieved
						systemSourceRate: toUnit('1'),
						systemDestinationRate: toUnit('1'),
					},
					() => {
						// No fees
						behaviors.whenMockedWithSynthUintSystemSetting(
							{ setting: 'exchangeFeeRate', synth: sETH, value: '0' },
							() => {
								it('gives exact amounts when no fees are configured', async () => {
									await assertAmountsReported({
										amountIn,
										atomicRate,
										feeRate: '0',
										instance: this.instance,
									});
								});
							}
						);

						// With fees
						behaviors.whenMockedWithSynthUintSystemSetting(
							{ setting: 'exchangeFeeRate', synth: sETH, value: baseFeeRate },
							() => {
								it('gives amounts with base fee', async () => {
									await assertAmountsReported({
										amountIn,
										atomicRate,
										feeRate: baseFeeRate,
										instance: this.instance,
									});
								});

								behaviors.whenMockedWithSynthUintSystemSetting(
									{ setting: 'atomicExchangeFeeRate', synth: sETH, value: overrideFeeRate },
									() => {
										it('gives amounts with atomic override fee', async () => {
											await assertAmountsReported({
												amountIn,
												atomicRate,
												feeRate: overrideFeeRate,
												instance: this.instance,
											});
										});
									}
								);
							}
						);

						behaviors.whenMockedWithSynthUintSystemSetting(
							{ setting: 'atomicExchangeFeeRate', synth: sETH, value: overrideFeeRate },
							() => {
								it('gives amounts with atomic override fee', async () => {
									await assertAmountsReported({
										amountIn,
										atomicRate,
										feeRate: overrideFeeRate,
										instance: this.instance,
									});
								});
							}
						);
					}
				);
			});

			describe('exchanging', () => {
				describe('exchange with virtual synths', () => {
					const sourceCurrency = uUSD;
					const destinationCurrency = sETH;

					const getExchangeArgs = ({
						from = owner,
						sourceCurrencyKey = sourceCurrency,
						sourceAmount = amountIn,
						destinationCurrencyKey = destinationCurrency,
						destinationAddress = owner,
						trackingCode = toBytes32(),
						asTribeOne = true,
					} = {}) => {
						const args = [
							from, // exchangeForAddress
							from, // from
							sourceCurrencyKey,
							sourceAmount,
							destinationCurrencyKey,
							destinationAddress,
							true, // virtualSynth
							from, // rewardAddress
							trackingCode,
						];

						return asTribeOne ? callAsTribeOne(args) : args;
					};

					describe('failure modes', () => {
						behaviors.whenMockedWithExchangeRatesValidityAtRound({ valid: false }, () => {
							it('reverts when either rate is invalid', async () => {
								await assert.revert(
									this.instance.exchange(...getExchangeArgs()),
									'rate stale or flagged'
								);
							});
						});

						behaviors.whenMockedWithExchangeRatesValidity({ valid: true }, () => {
							behaviors.whenMockedWithNoPriorExchangesToSettle(() => {
								behaviors.whenMockedWithUintSystemSetting(
									{ setting: 'waitingPeriodSecs', value: '0' },
									() => {
										behaviors.whenMockedEffectiveRateAsEqualAtRound(() => {
											behaviors.whenMockedLastNRates(() => {
												behaviors.whenMockedASingleSynthToIssueAndBurn(() => {
													behaviors.whenMockedExchangeStatePersistance(() => {
														it('it reverts trying to create a virtual synth with no supply', async () => {
															await assert.revert(
																this.instance.exchange(...getExchangeArgs({ sourceAmount: '0' })),
																'Zero amount'
															);
														});
														it('it reverts trying to virtualize into an inverse synth', async () => {
															await assert.revert(
																this.instance.exchange(
																	...getExchangeArgs({
																		sourceCurrencyKey: uUSD,
																		destinationCurrencyKey: iETH,
																	})
																),
																'Cannot virtualize this synth'
															);
														});
													});
												});
											});
										});
									}
								);
							});
						});
					});

					behaviors.whenMockedWithExchangeRatesValidity({ valid: true }, () => {
						behaviors.whenMockedWithNoPriorExchangesToSettle(() => {
							behaviors.whenMockedWithUintSystemSetting(
								{ setting: 'waitingPeriodSecs', value: '0' },
								() => {
									behaviors.whenMockedEffectiveRateAsEqualAtRound(() => {
										behaviors.whenMockedLastNRates(() => {
											behaviors.whenMockedASingleSynthToIssueAndBurn(() => {
												behaviors.whenMockedExchangeStatePersistance(() => {
													describe('when invoked', () => {
														let txn;
														beforeEach(async () => {
															txn = await this.instance.exchange(...getExchangeArgs());
														});
														it('emits a VirtualSynthCreated event with the correct underlying synth and amount', async () => {
															assert.eventEqual(txn, 'VirtualSynthCreated', {
																synth: this.mocks.synth.proxy.will.returnValue,
																currencyKey: sETH,
																amount: amountIn,
																recipient: owner,
															});
														});
														describe('when interrogating the Virtual Synths', () => {
															let vSynth;
															beforeEach(async () => {
																const VirtualSynth = artifacts.require('VirtualSynth');
																vSynth = await VirtualSynth.at(
																	getEventByName({ tx: txn, name: 'VirtualSynthCreated' }).args
																		.vSynth
																);
															});
															it('the vSynth has the correct synth', async () => {
																assert.equal(
																	await vSynth.synth(),
																	this.mocks.synth.proxy.will.returnValue
																);
															});
															it('the vSynth has the correct resolver', async () => {
																assert.equal(await vSynth.resolver(), this.resolver.address);
															});
															it('the vSynth has minted the correct amount to the user', async () => {
																assert.bnEqual(await vSynth.totalSupply(), amountIn);
																assert.bnEqual(await vSynth.balanceOf(owner), amountIn);
															});
															it('and the synth has been issued to the vSynth', async () => {
																assert.equal(this.mocks.synth.issue.calls[0][0], vSynth.address);
																assert.bnEqual(this.mocks.synth.issue.calls[0][1], amountIn);
															});
															it('the vSynth is an ERC-1167 minimal proxy instead of a full Virtual Synth', async () => {
																const vSynthCode = await web3.eth.getCode(vSynth.address);
																assert.equal(
																	vSynthCode,
																	buildMinimalProxyCode(this.mocks.VirtualSynthMastercopy.address)
																);
															});
														});
													});
												});
											});
										});
									});
								}
							);
						});
					});
				});

				describe('exchange atomically', () => {
					const sourceCurrency = uUSD;
					const destinationCurrency = sETH;

					const getExchangeArgs = ({
						from = owner,
						sourceCurrencyKey = sourceCurrency,
						sourceAmount = amountIn,
						destinationCurrencyKey = destinationCurrency,
						destinationAddress = owner,
						trackingCode = toBytes32(),
						asTribeOne = true,
						minAmount = toDecimal(0),
					} = {}) => {
						const args = [
							from,
							sourceCurrencyKey,
							sourceAmount,
							destinationCurrencyKey,
							destinationAddress,
							trackingCode,
							minAmount,
						];

						return asTribeOne ? callAsTribeOne(args) : args;
					};

					describe('when called by unauthorized', async () => {
						behaviors.whenMockedToAllowExchangeInvocationChecks(() => {
							it('it reverts when called by regular accounts', async () => {
								await onlyGivenAddressCanInvoke({
									fnc: this.instance.exchangeAtomically,
									args: getExchangeArgs({ asTribeOne: false }),
									accounts: accounts.filter(a => a !== this.mocks.TribeOne.address),
									reason: 'Exchanger: Only tribeone or a synth contract can perform this action',
									// address: this.mocks.TribeOne.address (doesnt work as this reverts due to lack of mocking setup)
								});
							});
						});
					});

					describe('when not exchangeable', () => {
						it('reverts when src and dest are the same', async () => {
							const args = getExchangeArgs({
								sourceCurrencyKey: uUSD,
								destinationCurrencyKey: uUSD,
							});
							await assert.revert(this.instance.exchangeAtomically(...args), "Can't be same synth");
						});

						it('reverts when input amount is zero', async () => {
							const args = getExchangeArgs({ sourceAmount: '0' });
							await assert.revert(this.instance.exchangeAtomically(...args), 'Zero amount');
						});

						// Invalid system rates
						behaviors.whenMockedWithExchangeRatesValidity({ valid: false }, () => {
							it('reverts when either rate is invalid', async () => {
								await assert.revert(
									this.instance.exchangeAtomically(...getExchangeArgs()),
									'rate stale or flagged'
								);
							});
						});

						behaviors.whenMockedWithExchangeRatesValidity({ valid: true }, () => {
							behaviors.whenMockedWithNoPriorExchangesToSettle(() => {
								const lastRate = toUnit('1');
								behaviors.whenMockedEntireExchangeRateConfiguration(
									{
										sourceCurrency,
										atomicRate: lastRate,
										systemSourceRate: lastRate,
										systemDestinationRate: lastRate,
									},
									() => {
										behaviors.whenMockedWithVolatileSynth({ synth: sETH, volatile: true }, () => {
											describe('when synth pricing is deemed volatile', () => {
												it('reverts due to src volatility', async () => {
													const args = getExchangeArgs({
														sourceCurrencyKey: sETH,
														destinationCurrencyKey: uUSD,
													});
													await assert.revert(
														this.instance.exchangeAtomically(...args),
														'Src synth too volatile'
													);
												});
												it('reverts due to dest volatility', async () => {
													const args = getExchangeArgs({
														sourceCurrencyKey: uUSD,
														destinationCurrencyKey: sETH,
													});
													await assert.revert(
														this.instance.exchangeAtomically(...args),
														'Dest synth too volatile'
													);
												});
											});
										});

										describe('when max volume limit (0) is surpassed', () => {
											it('reverts due to surpassed volume limit', async () => {
												const args = getExchangeArgs({ sourceAmount: toUnit('1') });
												await assert.revert(
													this.instance.exchangeAtomically(...args),
													'Surpassed volume limit'
												);
											});
										});

										behaviors.whenMockedWithUintSystemSetting(
											{ setting: 'atomicMaxVolumePerBlock', value: maxAtomicValuePerBlock },
											() => {
												describe(`when max volume limit (>0) is surpassed`, () => {
													const aboveVolumeLimit = maxAtomicValuePerBlock.add(toBN('1'));
													it('reverts due to surpassed volume limit', async () => {
														const args = getExchangeArgs({ sourceAmount: aboveVolumeLimit });
														await assert.revert(
															this.instance.exchangeAtomically(...args),
															'Surpassed volume limit'
														);
													});
												});
											}
										);
									}
								);
							});
						});
					});

					describe('when exchange rates hit circuit breakers', () => {
						behaviors.whenMockedSusdAndSethSeparatelyToIssueAndBurn(() => {
							behaviors.whenMockedWithExchangeRatesValidity({ valid: true }, () => {
								behaviors.whenMockedWithNoPriorExchangesToSettle(() => {
									behaviors.whenMockedWithSynthUintSystemSetting(
										{ setting: 'exchangeFeeRate', synth: sETH, value: '0' },
										() => {
											const lastRate = toUnit('10');
											const badRate = lastRate.mul(toBN(10)); // should hit deviation factor of 5x

											// Source rate invalid
											behaviors.whenMockedEntireExchangeRateConfiguration(
												{
													sourceCurrency: uUSD,
													atomicRate: lastRate,
													systemSourceRate: badRate,
													systemDestinationRate: lastRate,
												},
												() => {
													behaviors.whenMockedWithUintSystemSetting(
														{ setting: 'atomicMaxVolumePerBlock', value: maxAtomicValuePerBlock },
														() => {
															beforeEach('attempt exchange', async () => {
																this.mocks.ExchangeRates.rateWithSafetyChecks.returns(currencyKey =>
																	currencyKey === sETH
																		? [badRate.toString(), true, false]
																		: [lastRate.toString(), false, false]
																);
																await this.instance.exchangeAtomically(
																	...getExchangeArgs({
																		sourceCurrency: uUSD,
																		destinationCurrency: sETH,
																	})
																);
															});
															it('did not issue or burn synths', async () => {
																assert.equal(this.mocks.uUSD.issue.calls.length, 0);
																assert.equal(this.mocks.sETH.issue.calls.length, 0);
																assert.equal(this.mocks.uUSD.burn.calls.length, 0);
																assert.equal(this.mocks.sETH.burn.calls.length, 0);
															});
														}
													);
												}
											);

											// Dest rate invalid
											behaviors.whenMockedEntireExchangeRateConfiguration(
												{
													sourceCurrency: sETH,
													atomicRate: lastRate,
													systemSourceRate: lastRate,
													systemDestinationRate: badRate,
												},
												() => {
													behaviors.whenMockedWithUintSystemSetting(
														{ setting: 'atomicMaxVolumePerBlock', value: maxAtomicValuePerBlock },
														() => {
															beforeEach('attempt exchange', async () => {
																this.mocks.ExchangeRates.rateWithSafetyChecks.returns(currencyKey =>
																	currencyKey === sETH
																		? [badRate.toString(), true, false]
																		: [lastRate.toString(), false, false]
																);
																await this.instance.exchangeAtomically(
																	...getExchangeArgs({
																		sourceCurrency: sETH,
																		destinationCurrency: uUSD,
																	})
																);
															});
															it('did not issue or burn synths', async () => {
																assert.equal(this.mocks.uUSD.issue.calls.length, 0);
																assert.equal(this.mocks.sETH.issue.calls.length, 0);
																assert.equal(this.mocks.uUSD.burn.calls.length, 0);
																assert.equal(this.mocks.sETH.burn.calls.length, 0);
															});
														}
													);
												}
											);

											// Atomic rate invalid
											behaviors.whenMockedEntireExchangeRateConfiguration(
												{
													sourceCurrency,
													atomicRate: badRate,
													systemSourceRate: lastRate,
													systemDestinationRate: lastRate,
												},
												() => {
													it('reverts exchange', async () => {
														this.flexibleStorageMock.mockSystemSetting({
															setting: 'atomicMaxVolumePerBlock',
															value: maxAtomicValuePerBlock,
															type: 'uint',
														});
														this.mocks.CircuitBreaker.isDeviationAboveThreshold.returns(true);
														await assert.revert(
															this.instance.exchangeAtomically(...getExchangeArgs()),
															'Atomic rate deviates too much'
														);
													});
												}
											);
										}
									);
								});
							});
						});
					});

					describe('when atomic exchange occurs (uUSD -> sETH)', () => {
						const unit = toUnit('1');
						const lastUsdRate = unit;
						const lastEthRate = toUnit('100'); // 1 ETH -> 100 USD

						behaviors.whenMockedSusdAndSethSeparatelyToIssueAndBurn(() => {
							behaviors.whenMockedFeePool(() => {
								behaviors.whenMockedWithExchangeRatesValidity({ valid: true }, () => {
									behaviors.whenMockedWithNoPriorExchangesToSettle(() => {
										behaviors.whenMockedEntireExchangeRateConfiguration(
											{
												sourceCurrency,

												// we are always trading uUSD -> sETH
												atomicRate: lastEthRate,
												systemSourceRate: unit,
												systemDestinationRate: lastEthRate,
											},
											() => {
												behaviors.whenMockedWithUintSystemSetting(
													{ setting: 'exchangeMaxDynamicFee', value: toUnit('1') },
													() => {
														behaviors.whenMockedWithUintSystemSetting(
															{ setting: 'atomicMaxVolumePerBlock', value: maxAtomicValuePerBlock },
															() => {
																const itExchangesCorrectly = ({
																	exchangeFeeRate,
																	setAsOverrideRate,
																	tradingRewardsEnabled,
																	trackingCode,
																}) => {
																	behaviors.whenMockedWithBoolSystemSetting(
																		{
																			setting: 'tradingRewardsEnabled',
																			value: !!tradingRewardsEnabled,
																		},
																		() => {
																			behaviors.whenMockedWithSynthUintSystemSetting(
																				{
																					setting: setAsOverrideRate
																						? 'atomicExchangeFeeRate'
																						: 'exchangeFeeRate',
																					synth: sETH,
																					value: exchangeFeeRate,
																				},
																				() => {
																					let expectedAmountReceived;
																					let expectedFee;
																					beforeEach('attempt exchange', async () => {
																						expectedFee = multiplyDecimal(
																							amountIn,
																							exchangeFeeRate
																						);
																						expectedAmountReceived = divideDecimal(
																							amountIn.sub(expectedFee),
																							lastEthRate
																						);

																						await this.instance.exchangeAtomically(
																							...getExchangeArgs({
																								trackingCode,
																							})
																						);
																					});
																					it('burned correct amount of uUSD', () => {
																						assert.equal(this.mocks.uUSD.burn.calls[0][0], owner);
																						assert.bnEqual(
																							this.mocks.uUSD.burn.calls[0][1],
																							amountIn
																						);
																					});
																					it('issued correct amount of sETH', () => {
																						assert.equal(this.mocks.sETH.issue.calls[0][0], owner);
																						assert.bnEqual(
																							this.mocks.sETH.issue.calls[0][1],
																							expectedAmountReceived
																						);
																					});
																					it('tracked atomic volume', async () => {
																						assert.bnEqual(
																							(await this.instance.lastAtomicVolume()).volume,
																							amountIn
																						);
																					});
																					it('updated debt cache', () => {
																						const debtCacheUpdateCall = this.mocks.DebtCache
																							.updateCachedSynthDebtsWithRates;
																						assert.deepEqual(debtCacheUpdateCall.calls[0][0], [
																							uUSD,
																							sETH,
																						]);
																						assert.deepEqual(debtCacheUpdateCall.calls[0][1], [
																							lastUsdRate,
																							lastEthRate,
																						]);
																					});
																					it('asked TribeOne to emit an exchange event', () => {
																						const tribeoneEmitExchangeCall = this.mocks.TribeOne
																							.emitSynthExchange;
																						assert.equal(
																							tribeoneEmitExchangeCall.calls[0][0],
																							owner
																						);
																						assert.equal(
																							tribeoneEmitExchangeCall.calls[0][1],
																							uUSD
																						);
																						assert.bnEqual(
																							tribeoneEmitExchangeCall.calls[0][2],
																							amountIn
																						);
																						assert.equal(
																							tribeoneEmitExchangeCall.calls[0][3],
																							sETH
																						);
																						assert.bnEqual(
																							tribeoneEmitExchangeCall.calls[0][4],
																							expectedAmountReceived
																						);
																						assert.equal(
																							tribeoneEmitExchangeCall.calls[0][5],
																							owner
																						);
																					});
																					it('asked TribeOne to emit an atomic exchange event', () => {
																						const tribeoneEmitAtomicExchangeCall = this.mocks
																							.TribeOne.emitAtomicSynthExchange;
																						assert.equal(
																							tribeoneEmitAtomicExchangeCall.calls[0][0],
																							owner
																						);
																						assert.equal(
																							tribeoneEmitAtomicExchangeCall.calls[0][1],
																							uUSD
																						);
																						assert.bnEqual(
																							tribeoneEmitAtomicExchangeCall.calls[0][2],
																							amountIn
																						);
																						assert.equal(
																							tribeoneEmitAtomicExchangeCall.calls[0][3],
																							sETH
																						);
																						assert.bnEqual(
																							tribeoneEmitAtomicExchangeCall.calls[0][4],
																							expectedAmountReceived
																						);
																						assert.equal(
																							tribeoneEmitAtomicExchangeCall.calls[0][5],
																							owner
																						);
																					});
																					it('did not add any fee reclamation entries to exchange state', () => {
																						assert.equal(
																							this.mocks.ExchangeState.appendExchangeEntry.calls
																								.length,
																							0
																						);
																					});

																					// Conditional based on test settings
																					if (toBN(exchangeFeeRate).isZero()) {
																						it('did not report a fee', () => {
																							assert.equal(
																								this.mocks.FeePool.recordFeePaid.calls.length,
																								0
																							);
																						});
																					} else {
																						it('remitted correct fee to fee pool', () => {
																							assert.equal(
																								this.mocks.uUSD.issue.calls[0][0],
																								getUsers({ network: 'mainnet', user: 'fee' })
																									.address
																							);
																							assert.bnEqual(
																								this.mocks.uUSD.issue.calls[0][1],
																								expectedFee
																							);
																							assert.bnEqual(
																								this.mocks.FeePool.recordFeePaid.calls[0],
																								expectedFee
																							);
																						});
																					}
																					if (!tradingRewardsEnabled) {
																						it('did not report trading rewards', () => {
																							assert.equal(
																								this.mocks.TradingRewards
																									.recordExchangeFeeForAccount.calls.length,
																								0
																							);
																						});
																					} else {
																						it('reported trading rewards', () => {
																							const trRecordCall = this.mocks.TradingRewards
																								.recordExchangeFeeForAccount;
																							assert.bnEqual(trRecordCall.calls[0][0], expectedFee);
																							assert.equal(trRecordCall.calls[0][1], owner);
																						});
																					}
																					if (!trackingCode) {
																						it('did not ask TribeOne to emit tracking event', () => {
																							assert.equal(
																								this.mocks.TribeOne.emitExchangeTracking.calls
																									.length,
																								0
																							);
																						});
																					} else {
																						it('asked TribeOne to emit tracking event', () => {
																							const tribeoneEmitTrackingCall = this.mocks.TribeOne
																								.emitExchangeTracking;
																							assert.equal(
																								tribeoneEmitTrackingCall.calls[0][0],
																								trackingCode
																							);
																						});
																					}
																				}
																			);
																		}
																	);
																};

																describe('when no exchange fees are configured', () => {
																	itExchangesCorrectly({
																		exchangeFeeRate: '0',
																	});
																});

																describe('with tracking code', () => {
																	itExchangesCorrectly({
																		exchangeFeeRate: '0',
																		trackingCode: toBytes32('TRACKING'),
																	});
																});

																describe('when an exchange fee is configured', () => {
																	itExchangesCorrectly({
																		exchangeFeeRate: baseFeeRate,
																		tradingRewardsEnabled: true,
																	});
																});
																describe('when an exchange fee override for atomic exchanges is configured', () => {
																	itExchangesCorrectly({
																		exchangeFeeRate: overrideFeeRate,
																		setAsOverrideRate: true,
																		tradingRewardsEnabled: true,
																	});
																});
															}
														);
													}
												);
											}
										);
									});
								});
							});
						});
					});
				});
			});
		});
	});
});
