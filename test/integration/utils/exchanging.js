const ethers = require('ethers');
const { ensureBalance } = require('./balances');
const { toBytes32 } = require('../../../index');
const { updateCache } = require('../utils/rates');
const { skipWaitingPeriod } = require('../utils/skip');

async function exchangeSomething({ ctx }) {
	let { TribeOne } = ctx.contracts;
	TribeOne = TribeOne.connect(ctx.users.owner);

	const uUSDAmount = ethers.utils.parseEther('10');
	await ensureBalance({ ctx, symbol: 'uUSD', user: ctx.users.owner, balance: uUSDAmount });

	await updateCache({ ctx });

	const tx = await TribeOne.exchange(toBytes32('uUSD'), uUSDAmount, toBytes32('sETH'));
	await tx.wait();
}

async function exchangeSynths({ ctx, src, dest, amount, user }) {
	let { TribeOne, CircuitBreaker } = ctx.contracts;
	const { ExchangeRates } = ctx.contracts;
	TribeOne = TribeOne.connect(user);
	CircuitBreaker = CircuitBreaker.connect(ctx.users.owner);

	await ensureBalance({ ctx, symbol: src, user, balance: amount });

	// ensure that circuit breaker wont get in he way
	const oracles = [
		await ExchangeRates.aggregators(toBytes32(src)),
		await ExchangeRates.aggregators(toBytes32(dest)),
	].filter(o => o !== ethers.constants.AddressZero);
	let tx = await CircuitBreaker.resetLastValue(
		oracles,
		oracles.map(() => 0)
	);

	tx = await TribeOne.exchange(toBytes32(src), amount, toBytes32(dest));
	await tx.wait();

	await skipWaitingPeriod({ ctx });

	tx = await TribeOne.settle(toBytes32(dest));
	await tx.wait();
}

module.exports = {
	exchangeSomething,
	exchangeSynths,
};
