require('dotenv').config();

const AcceleratorVault = artifacts.require('AcceleratorVault');
const HodlerVault = artifacts.require('HodlerVault');
const UBAToken = artifacts.require('UnboxArtToken');
const UniswapFactory = artifacts.require('UniswapFactory');

const { 
  UNISWAP_FACTORY, 
  UNISWAP_ROUTER,
  WETH_KOVAN,
  UBA_TOKEN_MAINNET,
  UNISWAP_PAIR,
  HODLER_FEE_RECEIVER
} = process.env;

module.exports = async (deployer, network, accounts) => {
  const stakeDuration = 4;
  const donationShare = 0;
  const purchaseFee = 10;

  const hodlerStakeDuration = 15;
  const hodlerPurchaseFee = 10;



  if (network === 'development') {
    return;
  }

  await deployer.deploy(AcceleratorVault);
  const acceleratorVault = await AcceleratorVault.deployed();
  pausePromise('AcceleratorVault');

  await deployer.deploy(HodlerVault);
  const hodlerVault = await HodlerVault.deployed();
  pausePromise('HodlerVault');

  if (network === 'kovan') {
    await deployer.deploy(UBAToken);
    const ubaToken = await UBAToken.deployed();
    pausePromise('UBAToken');

    const uniswapFactory = await UniswapFactory.at(UNISWAP_FACTORY);
    await uniswapFactory.createPair(WETH_KOVAN, ubaToken.address);
    pausePromise('Create pair');

    uniswapPair = await uniswapFactory.getPair.call(WETH_KOVAN, ubaToken.address);

    await acceleratorVault.seed(
      stakeDuration,
      ubaToken.address,
      uniswapPair,
      UNISWAP_ROUTER,
      hodlerVault.address,
      donationShare,
      purchaseFee
    );

    await hodlerVault.seed(
      hodlerStakeDuration,
      ubaToken.address,
      uniswapPair,
      UNISWAP_ROUTER,
      HODLER_FEE_RECEIVER,
      hodlerPurchaseFee
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