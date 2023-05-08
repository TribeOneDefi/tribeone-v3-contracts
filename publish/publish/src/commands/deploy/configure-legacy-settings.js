'use strict';

const { gray } = require('chalk');
const { toBytes32 } = require('../../../..');

module.exports = async ({
	account,
	addressOf,
	config,
	deployer,
	getDeployParameter,
	network,
	runStep,
	useOvm,
}) => {
	console.log(gray(`\n------ CONFIGURE LEGACY CONTRACTS VIA SETTERS ------\n`));

	const {
		DelegateApprovals,
		DelegateApprovalsEternalStorage,
		Exchanger,
		ExchangeState,
		ExchangeCircuitBreaker,
		FeePool,
		FeePoolEternalStorage,
		Issuer,
		ProxyFeePool,
		ProxyTribeone,
		RewardEscrow,
		RewardsDistribution,
		SupplySchedule,
		Tribeone,
		TribeoneEscrow,
		SystemStatus,
		TokenStateTribeone,
	} = deployer.deployedContracts;

	// now configure everything
	if (network !== 'mainnet' && SystemStatus) {
		// On testnet, give the owner of SystemStatus the rights to update status
		const statusOwner = await SystemStatus.owner();
		await runStep({
			contract: 'SystemStatus',
			target: SystemStatus,
			read: 'accessControl',
			readArg: [toBytes32('System'), statusOwner],
			expected: ({ canSuspend } = {}) => canSuspend,
			write: 'updateAccessControls',
			writeArg: [
				['System', 'Issuance', 'Exchange', 'SynthExchange', 'Synth', 'Futures'].map(toBytes32),
				[statusOwner, statusOwner, statusOwner, statusOwner, statusOwner, statusOwner],
				[true, true, true, true, true, true],
				[true, true, true, true, true, true],
			],
			comment: 'Ensure the owner can suspend and resume the protocol',
		});
	}
	if (DelegateApprovals && DelegateApprovalsEternalStorage) {
		await runStep({
			contract: 'DelegateApprovalsEternalStorage',
			target: DelegateApprovalsEternalStorage,
			read: 'associatedContract',
			expected: input => input === addressOf(DelegateApprovals),
			write: 'setAssociatedContract',
			writeArg: addressOf(DelegateApprovals),
			comment: 'Ensure that DelegateApprovals contract is allowed to write to its EternalStorage',
		});
	}

	if (ProxyFeePool && FeePool) {
		await runStep({
			contract: 'ProxyFeePool',
			target: ProxyFeePool,
			read: 'target',
			expected: input => input === addressOf(FeePool),
			write: 'setTarget',
			writeArg: addressOf(FeePool),
			comment: 'Ensure the ProxyFeePool contract has the correct FeePool target set',
		});
	}

	if (FeePoolEternalStorage && FeePool) {
		await runStep({
			contract: 'FeePoolEternalStorage',
			target: FeePoolEternalStorage,
			read: 'associatedContract',
			expected: input => input === addressOf(FeePool),
			write: 'setAssociatedContract',
			writeArg: addressOf(FeePool),
			comment: 'Ensure the FeePool contract can write to its EternalStorage',
		});
	}

	if (ProxyTribeone && Tribeone) {
		await runStep({
			contract: 'ProxyTribeone',
			target: ProxyTribeone,
			read: 'target',
			expected: input => input === addressOf(Tribeone),
			write: 'setTarget',
			writeArg: addressOf(Tribeone),
			comment: 'Ensure the HAKA proxy has the correct Tribeone target set',
		});
		await runStep({
			contract: 'Tribeone',
			target: Tribeone,
			read: 'proxy',
			expected: input => input === addressOf(ProxyTribeone),
			write: 'setProxy',
			writeArg: addressOf(ProxyTribeone),
			comment: 'Ensure the Tribeone contract has the correct ERC20 proxy set',
		});
	}

	if (Exchanger && ExchangeState) {
		// The ExchangeState contract has Exchanger as it's associated contract
		await runStep({
			contract: 'ExchangeState',
			target: ExchangeState,
			read: 'associatedContract',
			expected: input => input === Exchanger.address,
			write: 'setAssociatedContract',
			writeArg: Exchanger.address,
			comment: 'Ensure the Exchanger contract can write to its State',
		});
	}

	if (ExchangeCircuitBreaker && SystemStatus) {
		// SIP-65: ensure Exchanger can suspend synths if price spikes occur
		await runStep({
			contract: 'SystemStatus',
			target: SystemStatus,
			read: 'accessControl',
			readArg: [toBytes32('Synth'), addressOf(ExchangeCircuitBreaker)],
			expected: ({ canSuspend } = {}) => canSuspend,
			write: 'updateAccessControl',
			writeArg: [toBytes32('Synth'), addressOf(ExchangeCircuitBreaker), true, false],
			comment: 'Ensure the ExchangeCircuitBreaker contract can suspend synths - see SIP-65',
		});
	}

	if (Issuer && SystemStatus) {
		// SIP-165: ensure Issuer can suspend issuance if unusual volitility occurs
		await runStep({
			contract: 'SystemStatus',
			target: SystemStatus,
			read: 'accessControl',
			readArg: [toBytes32('Issuance'), addressOf(Issuer)],
			expected: ({ canSuspend } = {}) => canSuspend,
			write: 'updateAccessControl',
			writeArg: [toBytes32('Issuance'), addressOf(Issuer), true, false],
			comment: 'Ensure Issuer contract can suspend issuance - see SIP-165',
		});
	}

	// only reset token state if redeploying
	if (TokenStateTribeone && config['TokenStateTribeone'].deploy) {
		const initialIssuance = await getDeployParameter('INITIAL_ISSUANCE');
		await runStep({
			contract: 'TokenStateTribeone',
			target: TokenStateTribeone,
			read: 'balanceOf',
			readArg: account,
			expected: input => input === initialIssuance,
			write: 'setBalanceOf',
			writeArg: [account, initialIssuance],
			comment:
				'Ensure the TokenStateTribeone contract has the correct initial issuance (WARNING: only for new deploys)',
		});
	}

	if (TokenStateTribeone && Tribeone) {
		await runStep({
			contract: 'TokenStateTribeone',
			target: TokenStateTribeone,
			read: 'associatedContract',
			expected: input => input === addressOf(Tribeone),
			write: 'setAssociatedContract',
			writeArg: addressOf(Tribeone),
			comment: 'Ensure the Tribeone contract can write to its TokenState contract',
		});
	}

	if (RewardEscrow && Tribeone) {
		await runStep({
			contract: 'RewardEscrow',
			target: RewardEscrow,
			read: 'tribeone',
			expected: input => input === addressOf(Tribeone),
			write: 'setTribeone',
			writeArg: addressOf(Tribeone),
			comment: 'Ensure the legacy RewardEscrow contract is connected to the Tribeone contract',
		});
	}

	if (RewardEscrow && FeePool) {
		await runStep({
			contract: 'RewardEscrow',
			target: RewardEscrow,
			read: 'feePool',
			expected: input => input === addressOf(FeePool),
			write: 'setFeePool',
			writeArg: addressOf(FeePool),
			comment: 'Ensure the legacy RewardEscrow contract is connected to the FeePool contract',
		});
	}

	if (SupplySchedule && Tribeone) {
		await runStep({
			contract: 'SupplySchedule',
			target: SupplySchedule,
			read: 'tribeoneProxy',
			expected: input => input === addressOf(ProxyTribeone),
			write: 'setTribeoneProxy',
			writeArg: addressOf(ProxyTribeone),
			comment: 'Ensure the SupplySchedule is connected to the HAKA proxy for reading',
		});
	}

	if (Tribeone && RewardsDistribution) {
		await runStep({
			contract: 'RewardsDistribution',
			target: RewardsDistribution,
			read: 'authority',
			expected: input => input === addressOf(Tribeone),
			write: 'setAuthority',
			writeArg: addressOf(Tribeone),
			comment: 'Ensure the RewardsDistribution has Tribeone set as its authority for distribution',
		});

		await runStep({
			contract: 'RewardsDistribution',
			target: RewardsDistribution,
			read: 'tribeoneProxy',
			expected: input => input === addressOf(ProxyTribeone),
			write: 'setTribeoneProxy',
			writeArg: addressOf(ProxyTribeone),
			comment: 'Ensure the RewardsDistribution can find the Tribeone proxy to read and transfer',
		});
	}

	// ----------------
	// Setting ProxyTribeone Tribeone for TribeoneEscrow
	// ----------------

	// Skip setting unless redeploying either of these,
	if (config['Tribeone'].deploy || config['TribeoneEscrow'].deploy) {
		// Note: currently on mainnet TribeoneEscrow.Tribeone() does NOT exist
		// it is "havven" and the ABI we have here is not sufficient
		if (network === 'mainnet' && !useOvm) {
			await runStep({
				contract: 'TribeoneEscrow',
				target: TribeoneEscrow,
				read: 'havven',
				expected: input => input === addressOf(ProxyTribeone),
				write: 'setHavven',
				writeArg: addressOf(ProxyTribeone),
				comment:
					'Ensure the legacy token sale escrow can find the Tribeone proxy to read and transfer',
			});
		} else {
			await runStep({
				contract: 'TribeoneEscrow',
				target: TribeoneEscrow,
				read: 'tribeone',
				expected: input => input === addressOf(ProxyTribeone),
				write: 'setTribeone',
				writeArg: addressOf(ProxyTribeone),
				comment: 'Ensure the token sale escrow can find the Tribeone proxy to read and transfer',
			});
		}
	}
};
