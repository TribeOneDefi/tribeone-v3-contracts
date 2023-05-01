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
		ProxyTribeOne,
		RewardEscrow,
		RewardsDistribution,
		SupplySchedule,
		TribeOne,
		TribeOneEscrow,
		SystemStatus,
		TokenStateTribeOne,
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

	if (ProxyTribeOne && TribeOne) {
		await runStep({
			contract: 'ProxyTribeOne',
			target: ProxyTribeOne,
			read: 'target',
			expected: input => input === addressOf(TribeOne),
			write: 'setTarget',
			writeArg: addressOf(TribeOne),
			comment: 'Ensure the HAKA proxy has the correct TribeOne target set',
		});
		await runStep({
			contract: 'TribeOne',
			target: TribeOne,
			read: 'proxy',
			expected: input => input === addressOf(ProxyTribeOne),
			write: 'setProxy',
			writeArg: addressOf(ProxyTribeOne),
			comment: 'Ensure the TribeOne contract has the correct ERC20 proxy set',
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
	if (TokenStateTribeOne && config['TokenStateTribeOne'].deploy) {
		const initialIssuance = await getDeployParameter('INITIAL_ISSUANCE');
		await runStep({
			contract: 'TokenStateTribeOne',
			target: TokenStateTribeOne,
			read: 'balanceOf',
			readArg: account,
			expected: input => input === initialIssuance,
			write: 'setBalanceOf',
			writeArg: [account, initialIssuance],
			comment:
				'Ensure the TokenStateTribeOne contract has the correct initial issuance (WARNING: only for new deploys)',
		});
	}

	if (TokenStateTribeOne && TribeOne) {
		await runStep({
			contract: 'TokenStateTribeOne',
			target: TokenStateTribeOne,
			read: 'associatedContract',
			expected: input => input === addressOf(TribeOne),
			write: 'setAssociatedContract',
			writeArg: addressOf(TribeOne),
			comment: 'Ensure the TribeOne contract can write to its TokenState contract',
		});
	}

	if (RewardEscrow && TribeOne) {
		await runStep({
			contract: 'RewardEscrow',
			target: RewardEscrow,
			read: 'tribeone',
			expected: input => input === addressOf(TribeOne),
			write: 'setTribeOne',
			writeArg: addressOf(TribeOne),
			comment: 'Ensure the legacy RewardEscrow contract is connected to the TribeOne contract',
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

	if (SupplySchedule && TribeOne) {
		await runStep({
			contract: 'SupplySchedule',
			target: SupplySchedule,
			read: 'tribeoneProxy',
			expected: input => input === addressOf(ProxyTribeOne),
			write: 'setTribeOneProxy',
			writeArg: addressOf(ProxyTribeOne),
			comment: 'Ensure the SupplySchedule is connected to the HAKA proxy for reading',
		});
	}

	if (TribeOne && RewardsDistribution) {
		await runStep({
			contract: 'RewardsDistribution',
			target: RewardsDistribution,
			read: 'authority',
			expected: input => input === addressOf(TribeOne),
			write: 'setAuthority',
			writeArg: addressOf(TribeOne),
			comment: 'Ensure the RewardsDistribution has TribeOne set as its authority for distribution',
		});

		await runStep({
			contract: 'RewardsDistribution',
			target: RewardsDistribution,
			read: 'tribeoneProxy',
			expected: input => input === addressOf(ProxyTribeOne),
			write: 'setTribeOneProxy',
			writeArg: addressOf(ProxyTribeOne),
			comment: 'Ensure the RewardsDistribution can find the TribeOne proxy to read and transfer',
		});
	}

	// ----------------
	// Setting ProxyTribeOne TribeOne for TribeOneEscrow
	// ----------------

	// Skip setting unless redeploying either of these,
	if (config['TribeOne'].deploy || config['TribeOneEscrow'].deploy) {
		// Note: currently on mainnet TribeOneEscrow.TribeOne() does NOT exist
		// it is "havven" and the ABI we have here is not sufficient
		if (network === 'mainnet' && !useOvm) {
			await runStep({
				contract: 'TribeOneEscrow',
				target: TribeOneEscrow,
				read: 'havven',
				expected: input => input === addressOf(ProxyTribeOne),
				write: 'setHavven',
				writeArg: addressOf(ProxyTribeOne),
				comment:
					'Ensure the legacy token sale escrow can find the TribeOne proxy to read and transfer',
			});
		} else {
			await runStep({
				contract: 'TribeOneEscrow',
				target: TribeOneEscrow,
				read: 'tribeone',
				expected: input => input === addressOf(ProxyTribeOne),
				write: 'setTribeOne',
				writeArg: addressOf(ProxyTribeOne),
				comment: 'Ensure the token sale escrow can find the TribeOne proxy to read and transfer',
			});
		}
	}
};
