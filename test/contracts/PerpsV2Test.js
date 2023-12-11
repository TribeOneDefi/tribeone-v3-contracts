const { ethers } = require('hardhat');
const perpsABI = require('../abi/PerpsV2Market.json').abi

describe('Perps Tests', () => {
    let contract;
    let proxy;    

    before(async () => {
        contract = await ethers.getContractAt(perpsABI, '0xEB6796e5AB07635b306150ef7Bd7468C71Bf77F1');
        proxy = await ethers.getImpersonatedSigner('0xE8623BE49838866F82D16f02137b67291678B485')
    });

    describe('Perps Tests ', () => {
        it('will open position', async () => {
            await contract.modifyPosition(50, 5432624999)
        })
    });
});

