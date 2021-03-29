require('dotenv').config();

const AcceleratorVault = artifacts.require('AcceleratorVault');
const UBAToken = artifacts.require('UnboxArtToken');
const PriceOracle = artifacts.require('PriceOracle');
const UniswapFactory = artifacts.require('UniswapFactory');

const { 
  UNISWAP_FACTORY, 
  UNISWAP_ROUTER,
  WETH_KOVAN,
  UBA_TOKEN_MAINNET,
  UNISWAP_PAIR
} = process.env;

module.exports = async (deployer, network, accounts) => {
  const hodlerVaultPlaceholder = accounts[3];
  const stakeDuration = 4;
  const donationShare = 0;
  const purchaseFee = 10;

  if (network === 'development') {
    return;
  }

  await deployer.deploy(AcceleratorVault);
  const acceleratorVault = await AcceleratorVault.deployed();
  pausePromise('AcceleratorVault');

  if (network === 'kovan') {
    await deployer.deploy(UBAToken, accounts[0]);
    const ubaToken = await UBAToken.deployed();
    pausePromise('UBAToken');

    const uniswapFactory = await UniswapFactory.at(UNISWAP_FACTORY);
    await uniswapFactory.createPair(WETH_KOVAN, ubaToken.address);
    pausePromise('Create pair');

    uniswapPair = await uniswapFactory.getPair.call(WETH_KOVAN, ubaToken.address);
    await deployer.deploy(PriceOracle, uniswapPair, ubaToken.address, WETH_KOVAN);
    const oracle = await PriceOracle.deployed();
    pausePromise('PriceOracle');
    
    await acceleratorVault.seed(
      stakeDuration, 
      ubaToken.address, 
      uniswapPair, 
      UNISWAP_ROUTER, 
      hodlerVaultPlaceholder,
      donationShare,
      purchaseFee,
      oracle
    );
  }
  
}

function pausePromise(message, durationInSeconds = 2) {
	return new Promise(function (resolve, error) {
		setTimeout(() => {
			console.log(message);
			return resolve();
		}, durationInSeconds * 1000);
	});
}