'use strict';

const { gray } = require('chalk');

module.exports = async ({ addressOf, deployer, runStep, tribesToAdd }) => {
	console.log(gray(`\n------ ADD TRIBES TO ISSUER ------\n`));

	const { Issuer } = deployer.deployedContracts;

	// Set up the connection to the Issuer for each Tribe (requires FlexibleStorage to have been configured)

	// First filter out all those tribes which are already properly imported
	console.log(gray('Filtering tribes to add to the issuer.'));
	const filteredTribes = [];
	const seen = new Set();
	for (const tribe of tribesToAdd) {
		const issuerTribeAddress = await Issuer.tribes(tribe.currencyKeyInBytes);
		const currentTribeAddress = addressOf(tribe.tribe);
		if (issuerTribeAddress === currentTribeAddress) {
			console.log(gray(`${currentTribeAddress} requires no action`));
		} else if (!seen.has(tribe.currencyKeyInBytes)) {
			console.log(gray(`${currentTribeAddress} will be added to the issuer.`));
			filteredTribes.push(tribe);
		}
		seen.add(tribe.currencyKeyInBytes);
	}

	const tribeChunkSize = 15;
	let batchCounter = 1;
	for (let i = 0; i < filteredTribes.length; i += tribeChunkSize) {
		const chunk = filteredTribes.slice(i, i + tribeChunkSize);
		await runStep({
			contract: 'Issuer',
			target: Issuer,
			read: 'getTribes',
			readArg: [chunk.map(tribe => tribe.currencyKeyInBytes)],
			expected: input =>
				input.length === chunk.length &&
				input.every((cur, idx) => cur === addressOf(chunk[idx].tribe)),
			write: 'addTribes',
			writeArg: [chunk.map(tribe => addressOf(tribe.tribe))],
			gasLimit: 1e5 * tribeChunkSize,
			comment: `Add tribes to the Issuer contract - batch ${batchCounter++}`,
		});
	}
};
