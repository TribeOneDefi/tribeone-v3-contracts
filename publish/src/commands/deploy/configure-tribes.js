'use strict';

const { gray } = require('chalk');
const {
	utils: { isAddress },
} = require('ethers');
const { toBytes32 } = require('../../../..');

module.exports = async ({
	addressOf,
	deployer,
	explorerLinkPrefix,
	feeds,
	generateSolidity,
	network,
	runStep,
	tribes,
}) => {
	// now configure tribes
	console.log(gray(`\n------ CONFIGURE TRIBES ------\n`));

	const { ExchangeRates } = deployer.deployedContracts;

	for (const { name: currencyKey, asset } of tribes) {
		console.log(gray(`\n   --- TRIBE ${currencyKey} ---\n`));

		const currencyKeyInBytes = toBytes32(currencyKey);

		const tribe = deployer.deployedContracts[`Tribe${currencyKey}`];
		const tokenStateForTribe = deployer.deployedContracts[`TokenState${currencyKey}`];
		const proxyForTribe = deployer.deployedContracts[`Proxy${currencyKey}`];

		let ExistingTribe;
		try {
			ExistingTribe = deployer.getExistingContract({ contract: `Tribe${currencyKey}` });
		} catch (err) {
			// ignore error as there is no existing tribe to copy from
		}
		// when generating solidity only, ensure that this is run to copy across tribe supply
		if (tribe && generateSolidity && ExistingTribe && ExistingTribe.address !== tribe.address) {
			const generateExplorerComment = ({ address }) =>
				`// ${explorerLinkPrefix}/address/${address}`;

			await runStep({
				contract: `Tribe${currencyKey}`,
				target: tribe,
				write: 'setTotalSupply',
				writeArg: addressOf(tribe),
				comment: `Ensure the new tribe has the totalSupply from the previous one`,
				customSolidity: {
					name: `copyTotalSupplyFrom_${currencyKey}`,
					instructions: [
						generateExplorerComment({ address: ExistingTribe.address }),
						`Tribe existingTribe = Tribe(${ExistingTribe.address})`,
						generateExplorerComment({ address: tribe.address }),
						`Tribe newTribe = Tribe(${tribe.address})`,
						`newTribe.setTotalSupply(existingTribe.totalSupply())`,
					],
				},
			});
		}

		if (tokenStateForTribe && tribe) {
			await runStep({
				contract: `TokenState${currencyKey}`,
				target: tokenStateForTribe,
				read: 'associatedContract',
				expected: input => input === addressOf(tribe),
				write: 'setAssociatedContract',
				writeArg: addressOf(tribe),
				comment: `Ensure the ${currencyKey} tribe can write to its TokenState`,
			});
		}

		// Setup proxy for tribe
		if (proxyForTribe && tribe) {
			await runStep({
				contract: `Proxy${currencyKey}`,
				target: proxyForTribe,
				read: 'target',
				expected: input => input === addressOf(tribe),
				write: 'setTarget',
				writeArg: addressOf(tribe),
				comment: `Ensure the ${currencyKey} tribe Proxy is correctly connected to the Tribe`,
			});

			await runStep({
				contract: `Tribe${currencyKey}`,
				target: tribe,
				read: 'proxy',
				expected: input => input === addressOf(proxyForTribe),
				write: 'setProxy',
				writeArg: addressOf(proxyForTribe),
				comment: `Ensure the ${currencyKey} tribe is connected to its Proxy`,
			});
		}

		const { feed } = feeds[asset] || {};

		// now setup price aggregator if any for the tribe
		if (isAddress(feed) && ExchangeRates) {
			await runStep({
				contract: `ExchangeRates`,
				target: ExchangeRates,
				read: 'aggregators',
				readArg: currencyKeyInBytes,
				expected: input => input === feed,
				write: 'addAggregator',
				writeArg: [currencyKeyInBytes, feed],
				comment: `Ensure the ExchangeRates contract has the feed for ${currencyKey}`,
			});
		}
	}
};
