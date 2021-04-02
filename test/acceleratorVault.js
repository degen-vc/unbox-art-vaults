const Ganache = require('./helpers/ganache');
const deployUniswap = require('./helpers/deployUniswap');
const { expectEvent, expectRevert, constants } = require("@openzeppelin/test-helpers");
const { web3 } = require('@openzeppelin/test-helpers/src/setup');

const UnboxArtToken = artifacts.require('UnboxArtToken');
const AcceleratorVault = artifacts.require('AcceleratorVault');
const IUniswapV2Pair = artifacts.require('IUniswapV2Pair');
const PriceOracle = artifacts.require('PriceOracle');

const bn = (input) => web3.utils.toBN(input)
const assertBNequal = (bnOne, bnTwo) => assert.equal(bnOne.toString(), bnTwo.toString())


contract('Accelerator vault', function(accounts) {
  const ganache = new Ganache(web3);
  afterEach('revert', ganache.revert);

  const bn = (input) => web3.utils.toBN(input);
  const assertBNequal = (bnOne, bnTwo) => assert.equal(bnOne.toString(), bnTwo.toString());

  const OWNER = accounts[0];
  const NOT_OWNER = accounts[1];
  const HODLER_VAULT_FAKE = accounts[2];
  const baseUnit = bn('1000000000000000000');
  const startTime = Math.floor(Date.now() / 1000);
  const stakeDuration = 1;
  const donationShare = 10;
  const purchaseFee = 10;

  let uniswapOracle;
  let uniswapPair;
  let uniswapFactory;
  let uniswapRouter;
  let weth;

  let ubaToken;
  let acceleratorVault;

  before('setup others', async function() {
    const contracts = await deployUniswap(accounts);
    uniswapFactory = contracts.uniswapFactory;
    uniswapRouter = contracts.uniswapRouter;
    weth = contracts.weth;

    // deploy and setup main contracts
    ubaToken = await UnboxArtToken.new();
    acceleratorVault = await AcceleratorVault.new();

    await uniswapFactory.createPair(weth.address, ubaToken.address);
    uniswapPair = await uniswapFactory.getPair.call(weth.address, ubaToken.address);


    uniswapOracle = await PriceOracle.new(uniswapPair, ubaToken.address, weth.address);

    await acceleratorVault.seed(
      stakeDuration,
      ubaToken.address,
      uniswapPair,
      uniswapRouter.address,
      HODLER_VAULT_FAKE,
      donationShare,
      purchaseFee,
      uniswapOracle.address
    );

    await ganache.snapshot();
  });

  describe('General tests', async () => {
    it('should set all values after AV setup', async () => {
      const config = await acceleratorVault.config();
      assert.equal(config.ubaToken, ubaToken.address);
      assert.equal(config.tokenPair, uniswapPair);
      assert.equal(config.uniswapRouter, uniswapRouter.address);
      assert.equal(config.ethHodler, HODLER_VAULT_FAKE);
      assert.equal(config.weth, weth.address);
      assert.equal(config.uniswapOracle, uniswapOracle.address);
      assertBNequal(config.stakeDuration, 86400);
      assertBNequal(config.donationShare, donationShare);
      assertBNequal(config.purchaseFee, purchaseFee);
    });

    it('should not set an oracle from non-owner', async () => {
      await expectRevert(
        acceleratorVault.setOracleAddress(uniswapOracle.address, { from: NOT_OWNER }),
        'Ownable: caller is not the owner'
      );
    });

    it('should set new oracle', async () => {
      const FAKE_ORACLE = accounts[3];
      await acceleratorVault.setOracleAddress(FAKE_ORACLE);
      const { uniswapOracle } = await acceleratorVault.config();

      assert.equal(uniswapOracle, FAKE_ORACLE);
    });

    it('should not set parameters from non-owner', async () => {
      await expectRevert(
        acceleratorVault.setParameters(stakeDuration, donationShare, purchaseFee, { from: NOT_OWNER }),
        'Ownable: caller is not the owner'
      );
    });

    it('should set new parameters', async () => {
      const newStakeDuration = 8;
      const newDonationShare = 20;
      const newPurchaseFee = 20;
      
      await acceleratorVault.setParameters(newStakeDuration, newDonationShare, newPurchaseFee);
      const { stakeDuration, donationShare, purchaseFee } = await acceleratorVault.config();

      assertBNequal(stakeDuration, 691200);
      assertBNequal(donationShare, newDonationShare);
      assertBNequal(purchaseFee, newPurchaseFee);
    });

    it('should not do a forced unlock from non-owner', async () => {
      await expectRevert(
        acceleratorVault.enableLPForceUnlock({ from: NOT_OWNER }),
        'Ownable: caller is not the owner'
      );
    });

    it('should do a forced unlock and set lock period to 0', async () => {
      await acceleratorVault.enableLPForceUnlock();
      const stakeDuration = await acceleratorVault.getStakeDuration();

      assert.isTrue(await acceleratorVault.forceUnlock());
      assertBNequal(stakeDuration, 0);
    });

    it('should not set hodler\'s address from non-owner', async () => {
      const NEW_HODLER = accounts[3];

      await expectRevert(
        acceleratorVault.setEthHodlerAddress(NEW_HODLER, { from: NOT_OWNER }),
        'Ownable: caller is not the owner'
      );
    });

    it('should set hodler\'s address', async () => {
      const NEW_HODLER = accounts[3];
      await acceleratorVault.setEthHodlerAddress(NEW_HODLER);
      const { ethHodler } = await acceleratorVault.config();

      assert.equal(ethHodler, NEW_HODLER);
    });

    it('should not set ETH fee to transfer to HodlerVault from non-owner', async () => {
      await expectRevert(
        acceleratorVault.setEthFeeToHodler({ from: NOT_OWNER }),
        'Ownable: caller is not the owner'
      );
    });

    it('should set ETH fee to transfer to HodlerVault', async () => {
      assert.isFalse(await acceleratorVault.ethFeeTransferEnabled());
      await acceleratorVault.setEthFeeToHodler();
      assert.isTrue(await acceleratorVault.ethFeeTransferEnabled());
    });

    it('should not set ETH fee to swap (buy pressure) from non-owner', async () => {
      await expectRevert(
        acceleratorVault.setBuyPressure({ from: NOT_OWNER }),
        'Ownable: caller is not the owner'
      );
    });

    it('should set ETH fee to swap (buy pressure)', async () => {
      await acceleratorVault.setBuyPressure();
      assert.isFalse(await acceleratorVault.ethFeeTransferEnabled());
    });
  });

  describe('Purchase LP with swapping ETH fee for tokens (buy pressure) tests', async () => {
    it('should not purchase LP with no UBA tokens in Vault', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('5').mul(baseUnit); // 5 ETH
      const purchaseValue = bn('1').mul(baseUnit); // 1 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);
      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        NOT_OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      await expectRevert(
        acceleratorVault.purchaseLP({ value: purchaseValue }),
        'AcceleratorVault: insufficient UBA tokens in AcceleratorVault'
      );
    });

    it('should purchase LP for 1 ETH', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('5').mul(baseUnit); // 5 ETH
      const transferToAccelerator = bn('20000').mul(baseUnit); // 20.000 tokens
      const purchaseValue = bn('1').mul(baseUnit); // 1 ETH
      const pair = await IUniswapV2Pair.at(uniswapPair);

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);
      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        NOT_OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      await ubaToken.transfer(acceleratorVault.address, transferToAccelerator);
      const vaultBalance = await ubaToken.balanceOf(acceleratorVault.address);
      assertBNequal(vaultBalance, transferToAccelerator);

      // make sure buy pressure (swap) is on
      assert.isFalse(await acceleratorVault.ethFeeTransferEnabled());
      
      const estimatedFeeAmount = (purchaseValue * purchaseFee) / 100;
      const purchaseLP = await acceleratorVault.purchaseLP({ value: purchaseValue });
      const vaultBalanceAfter = await ubaToken.balanceOf(acceleratorVault.address);

      expectEvent(purchaseLP, 'EthFeeSwapped', {
        swappedAmount: estimatedFeeAmount.toString(),
        token0: weth.address,
        token1: ubaToken.address,
        receiver: acceleratorVault.address
      });

      await expectEvent.inTransaction(purchaseLP.tx, pair, 'Swap');

      const lockedLpLength = await acceleratorVault.lockedLPLength(OWNER);
      assertBNequal(lockedLpLength, 1);

      const lockedLP = await acceleratorVault.getLockedLP(OWNER, 0);
      const { amount, timestamp } = purchaseLP.logs[1].args;
      assert.equal(lockedLP[0], OWNER);
      assertBNequal(lockedLP[1], amount);
      assertBNequal(lockedLP[2], timestamp);
    });
  });

  describe('Purchase LP with transferring ETH fee to HodlerVault tests', async () => {
    it('should not purchase LP with 0 ETH', async () => {
      await expectRevert(
        acceleratorVault.purchaseLP(),
        'AcceleratorVault: ETH required to mint UBA LP'
      );
    });

    it('should not purchase LP with no UBA tokens in Vault', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('5').mul(baseUnit); // 5 ETH
      const purchaseValue = bn('1').mul(baseUnit); // 1 ETH

      await acceleratorVault.setEthFeeToHodler();

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);
      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        NOT_OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      await expectRevert(
        acceleratorVault.purchaseLP({ value: purchaseValue }),
        'AcceleratorVault: insufficient UBA tokens in AcceleratorVault'
      );
    });

    it('should purchase LP for 1 ETH', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('5').mul(baseUnit); // 5 ETH
      const transferToAccelerator = bn('20000').mul(baseUnit); // 20.000 tokens
      const purchaseValue = bn('1').mul(baseUnit); // 1 ETH

      await acceleratorVault.setEthFeeToHodler();
      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);
      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        NOT_OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      await ubaToken.transfer(acceleratorVault.address, transferToAccelerator);
      const vaultBalance = await ubaToken.balanceOf(acceleratorVault.address);
      assertBNequal(vaultBalance, transferToAccelerator);
      
      const hodlerBalanceBefore = bn(await web3.eth.getBalance(HODLER_VAULT_FAKE));
      const purchaseLP = await acceleratorVault.purchaseLP({ value: purchaseValue });
      const lockedLpLength = await acceleratorVault.lockedLPLength(OWNER);
      assertBNequal(lockedLpLength, 1);

      const lockedLP = await acceleratorVault.getLockedLP(OWNER, 0);
      const { amount, timestamp } = purchaseLP.logs[1].args;
      assert.equal(lockedLP[0], OWNER);
      assertBNequal(lockedLP[1], amount);
      assertBNequal(lockedLP[2], timestamp);

      const { ethHodler } = await acceleratorVault.config();
      const { to, percentageAmount } = purchaseLP.logs[2].args;
      const estimatedHodlerAmount = (purchaseValue * purchaseFee) / 100;
      const hodlerBalanceAfter = bn(await web3.eth.getBalance(HODLER_VAULT_FAKE));

      expectEvent(purchaseLP, 'EthFeeTransferred', {
        transferredAmount: estimatedHodlerAmount.toString(),
        destination: HODLER_VAULT_FAKE
      });
      
      assert.equal(ethHodler, HODLER_VAULT_FAKE);
      assert.equal(ethHodler, to);
      assertBNequal(hodlerBalanceAfter.sub(hodlerBalanceBefore), estimatedHodlerAmount);
      assertBNequal(estimatedHodlerAmount, percentageAmount);

    });

    it('should not purchase LP with too much ETH', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('5').mul(baseUnit); // 5 ETH
      const transferToAccelerator = bn('200').mul(baseUnit); // 200 tokens
      const purchaseValue = bn('10').mul(baseUnit); // 1 ETH

      await acceleratorVault.setEthFeeToHodler();
      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);
      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        NOT_OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      await ubaToken.transfer(acceleratorVault.address, transferToAccelerator);
      const vaultBalance = await ubaToken.balanceOf(acceleratorVault.address);
      assertBNequal(vaultBalance, transferToAccelerator);

      await expectRevert(
        acceleratorVault.purchaseLP({ value: purchaseValue }),
        'AcceleratorVault: insufficient UBA tokens in AcceleratorVault'
      );
    });
  });

  describe('ClaimLP', async () => {
    it('should not be to claim if there is no locked LP', async () => {
      await expectRevert(
        acceleratorVault.claimLP(),
        'AcceleratorVault: nothing to claim.'
      );
    });

    it('should not be able to claim if LP is still locked', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('5').mul(baseUnit); // 5 ETH
      const transferToAccelerator = bn('20000').mul(baseUnit); // 20.000 tokens
      const purchaseValue = bn('1').mul(baseUnit); // 1 ETH

      await acceleratorVault.setEthFeeToHodler();
      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);
      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        NOT_OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      await ubaToken.transfer(acceleratorVault.address, transferToAccelerator);
      await acceleratorVault.purchaseLP({ value: purchaseValue });

      await expectRevert(
        acceleratorVault.claimLP(),
        'AcceleratorVault: LP still locked.'
      );
    });

    it('should be able to claim 1 batch after 1 purchase', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('5').mul(baseUnit); // 5 ETH
      const transferToAccelerator = bn('20000').mul(baseUnit); // 20.000 tokens
      const purchaseValue = bn('1').mul(baseUnit); // 1 ETH
      const pair = await IUniswapV2Pair.at(uniswapPair);

      await acceleratorVault.setEthFeeToHodler();
      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);
      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        NOT_OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      ganache.setTime(startTime);
      await ubaToken.transfer(acceleratorVault.address, transferToAccelerator);
      await acceleratorVault.purchaseLP({ value: purchaseValue });
      const lockedLP = await acceleratorVault.getLockedLP(OWNER, 0);
      const { donationShare } = await acceleratorVault.config();
      const stakeDuration = await acceleratorVault.getStakeDuration();
      const lpBalanceBefore = await pair.balanceOf(OWNER);

      ganache.setTime(bn(startTime).add(stakeDuration));
      const claimLP = await acceleratorVault.claimLP();
      const { holder, amount, exitFee, claimed } = claimLP.logs[0].args;
      const estimatedFeeAmount = lockedLP[1].mul(donationShare).div(bn('100'));
      const lpBalanceAfter = await pair.balanceOf(OWNER);
      
      assert.equal(holder, OWNER);
      assert.isTrue(claimed);
      assertBNequal(amount, lockedLP[1]);
      assertBNequal(exitFee, estimatedFeeAmount);
      assertBNequal(amount.sub(exitFee), lpBalanceAfter.sub(lpBalanceBefore));
    });

    it('should be able to claim 2 batches after 2 purchases and 1 3rd party purchase', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('5').mul(baseUnit); // 5 ETH
      const transferToAccelerator = bn('20000').mul(baseUnit); // 20.000 tokens
      const purchaseValue = bn('1').mul(baseUnit); // 1 ETH
      const pair = await IUniswapV2Pair.at(uniswapPair);

      await acceleratorVault.setEthFeeToHodler();
      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);
      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        NOT_OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      ganache.setTime(startTime);
      await ubaToken.transfer(acceleratorVault.address, transferToAccelerator);
      
      await acceleratorVault.purchaseLP({ value: purchaseValue });
      await acceleratorVault.purchaseLP({ value: purchaseValue });

      await acceleratorVault.purchaseLP({ value: purchaseValue, from: NOT_OWNER });

      assertBNequal(await acceleratorVault.lockedLPLength(OWNER), 2);
      assertBNequal(await acceleratorVault.lockedLPLength(NOT_OWNER), 1);

      const lockedLP1 = await acceleratorVault.getLockedLP(OWNER, 0);
      const lockedLP2 = await acceleratorVault.getLockedLP(OWNER, 1);
      const lockedLP3 = await acceleratorVault.getLockedLP(NOT_OWNER, 0);
      const stakeDuration = await acceleratorVault.getStakeDuration();
      const lpBalanceBefore = await pair.balanceOf(OWNER);

      ganache.setTime(bn(startTime).add(stakeDuration));
      const claimLP1 = await acceleratorVault.claimLP();
      const { amount: amount1, exitFee: exitFee1 } = claimLP1.logs[0].args;
      
      const claimLP2 = await acceleratorVault.claimLP();
      const { amount: amount2, exitFee: exitFee2 } = claimLP2.logs[0].args;
      
      const expectedLpAmount = amount1.sub(exitFee1).add(amount2.sub(exitFee2));
      const lpBalanceAfter = await pair.balanceOf(OWNER);

      assertBNequal(lpBalanceAfter.sub(lpBalanceBefore), expectedLpAmount);
      assertBNequal(amount1, lockedLP1[1]);
      assertBNequal(amount2, lockedLP2[1]);

      // an attempt to claim nonexistent batch
      await expectRevert(
        acceleratorVault.claimLP(),
        'AcceleratorVault: nothing to claim.'
      );

      const lpBalanceBefore3 = await pair.balanceOf(NOT_OWNER);
      const claimLP3 = await acceleratorVault.claimLP({ from: NOT_OWNER });
      const { holder: holder3, amount: amount3, exitFee: exitFee3 } = claimLP3.logs[0].args;

      const expectedLpAmount3 = amount3.sub(exitFee3);
      const lpBalanceAfter3 = await pair.balanceOf(NOT_OWNER);

      assert.equal(holder3, NOT_OWNER);
      assertBNequal(amount3, lockedLP3[1]);
      assertBNequal(lpBalanceAfter3.sub(lpBalanceBefore3), expectedLpAmount3);
    });

    it('should be able to claim LP after force unlock', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('5').mul(baseUnit); // 5 ETH
      const transferToAccelerator = bn('20000').mul(baseUnit); // 20.000 tokens
      const purchaseValue = bn('1').mul(baseUnit); // 1 ETH
      const pair = await IUniswapV2Pair.at(uniswapPair);

      await acceleratorVault.setEthFeeToHodler();
      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);
      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        NOT_OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      ganache.setTime(startTime);
      await ubaToken.transfer(acceleratorVault.address, transferToAccelerator);
      
      await acceleratorVault.purchaseLP({ value: purchaseValue });
      await acceleratorVault.purchaseLP({ value: purchaseValue });

      const lockedLP1 = await acceleratorVault.getLockedLP(OWNER, 0);
      const lockedLP2 = await acceleratorVault.getLockedLP(OWNER, 1);
      
      await acceleratorVault.enableLPForceUnlock();
      const stakeDuration = await acceleratorVault.getStakeDuration();
      const lpBalanceBefore = await pair.balanceOf(OWNER);

      assert.isTrue(await acceleratorVault.forceUnlock());
      assertBNequal(stakeDuration, 0);

      ganache.setTime(bn(startTime).add(bn(5)));

      const claimLP1 = await acceleratorVault.claimLP();
      const { amount: amount1, exitFee: exitFee1 } = claimLP1.logs[0].args;
      assertBNequal(amount1, lockedLP1[1]);

      const claimLP2 = await acceleratorVault.claimLP();
      const { amount: amount2, exitFee: exitFee2 } = claimLP2.logs[0].args;
      assertBNequal(amount2, lockedLP2[1]);

      const expectedLpAmount = amount1.sub(exitFee1).add(amount2.sub(exitFee2));
      const lpBalanceAfter = await pair.balanceOf(OWNER);
      assertBNequal(lpBalanceAfter.sub(lpBalanceBefore), expectedLpAmount);
    });
  });
});
