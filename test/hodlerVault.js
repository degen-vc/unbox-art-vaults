
const Ganache = require('./helpers/ganache');
const deployUniswap = require('./helpers/deployUniswap');
const { expectEvent, expectRevert, constants } = require("@openzeppelin/test-helpers");
const { web3 } = require('@openzeppelin/test-helpers/src/setup');

const UnboxArtToken = artifacts.require('UnboxArtToken');
const HodlerVault = artifacts.require('HodlerVault');
const IERC20 = artifacts.require('IERC20');

const bn = (input) => web3.utils.toBN(input)
const assertBNequal = (bnOne, bnTwo) => assert.equal(bnOne.toString(), bnTwo.toString())


contract('Hodler vault', function(accounts) {
  const ganache = new Ganache(web3);
  afterEach('revert', ganache.revert);

  const bn = (input) => web3.utils.toBN(input);
  const assertBNequal = (bnOne, bnTwo) => assert.equal(bnOne.toString(), bnTwo.toString());

  const OWNER = accounts[0];
  const NOT_OWNER = accounts[1];
  const USER = accounts[2];
  const USER_2 = accounts[3];
  const FEE_RECEIVER = '0x38786ff354b4351F41c6763fc40F7124df01082B';
  const baseUnit = bn('1000000000000000000');
  const startTime = Math.floor(Date.now() / 1000);
  const lockTime = 86400; // 1day
  const stakeDuration = 1;
  const purchaseFee = 0; // 0%

  let uniswapPair;
  let uniswapFactory;
  let uniswapRouter;
  let weth;
  let pair;

  let ubaToken;
  let hodlerVault;

  before('setup others', async function() {
    const contracts = await deployUniswap(accounts);
    uniswapFactory = contracts.uniswapFactory;
    uniswapRouter = contracts.uniswapRouter;
    weth = contracts.weth;

    // deploy and setup main contracts
    ubaToken = await UnboxArtToken.new();
    hodlerVault = await HodlerVault.new();

    await uniswapFactory.createPair(weth.address, ubaToken.address);
    uniswapPair = await uniswapFactory.getPair.call(weth.address, ubaToken.address);

    await hodlerVault.seed(
      stakeDuration,
      ubaToken.address,
      uniswapPair,
      uniswapRouter.address,
      FEE_RECEIVER,
      purchaseFee
    );

    pair = await IERC20.at(uniswapPair);

    await ganache.snapshot();
  });

  it('should set all values after HV setup', async () => {
    const config = await hodlerVault.config();
    assert.equal(config.ubaToken, ubaToken.address);
    assert.equal(config.tokenPair, uniswapPair);
    assert.equal(config.uniswapRouter, uniswapRouter.address);
    assert.equal(config.weth, weth.address);
    assertBNequal(config.stakeDuration, 86400);
  });

  describe('Purchase LP', async () => {
    it('should be possible to purchaseLP', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const tokensAmount = bn('500').mul(baseUnit);

      await ubaToken.transfer(USER, tokensAmount);

      await hodlerVault.sendTransaction({value: bn('11').mul(baseUnit)})

      await ubaToken.approve(hodlerVault.address, tokensAmount, {from: USER});

      assertBNequal(await hodlerVault.lockedLPLength(USER), 0);
      assertBNequal(await pair.balanceOf(hodlerVault.address), 0);

      const result = await hodlerVault.purchaseLP(tokensAmount, {from: USER});
      const lpLocked = '15811388300841896659';
      assertBNequal(await pair.balanceOf(hodlerVault.address), lpLocked);


      assertBNequal(await hodlerVault.lockedLPLength(USER), 1);
      const lockedLPObj = await hodlerVault.getLockedLP(USER, 0);
      assertBNequal(lockedLPObj[1], lpLocked);


      expectEvent(result, 'LPQueued', {
        hodler: USER,
        ubaTokens: tokensAmount.toString()
      });
    });

    it('should be possible to purchaseLP and purchaseFee should be swapped and send to the feeReceiver', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH
      const ubaFee = bn(20); // 20%
      await hodlerVault.setParameters(5, 0, ubaFee);

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const tokensAmount = bn('500').mul(baseUnit);
      const tokensFee = tokensAmount.mul(ubaFee).div(bn(100));
      const tokensNet = tokensAmount.sub(tokensFee);

      await ubaToken.transfer(USER, tokensAmount);

      await hodlerVault.sendTransaction({value: bn('11').mul(baseUnit)})

      await ubaToken.approve(hodlerVault.address, tokensAmount, {from: USER});

      assertBNequal(await hodlerVault.lockedLPLength(USER), 0);
      assertBNequal(await pair.balanceOf(hodlerVault.address), 0);

      //TODO test all with fee here
      await hodlerVault.approveOnUni();

      assertBNequal(await web3.eth.getBalance(FEE_RECEIVER), 0);

      const result = await hodlerVault.purchaseLP(tokensAmount, {from: USER});

      const feeReceiverBalance = await web3.eth.getBalance(FEE_RECEIVER)
      assert.isTrue(bn('98000000000000000').lt(bn(feeReceiverBalance.toString())));

      const lpLocked = '12649110640673517327';
      assertBNequal(await pair.balanceOf(hodlerVault.address), lpLocked);


      assertBNequal(await hodlerVault.lockedLPLength(USER), 1);
      const lockedLPObj = await hodlerVault.getLockedLP(USER, 0);
      assertBNequal(lockedLPObj[1], lpLocked);


      expectEvent(result, 'LPQueued', {
        hodler: USER,
        ubaTokens: tokensNet.toString()
      });
    });

    it('should NOT be possible to send 0 tokens on HV via purchaseLP()', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const tokensAmount = bn('500').mul(baseUnit);

      await ubaToken.transfer(USER, tokensAmount);

      await hodlerVault.sendTransaction({value: bn('11').mul(baseUnit)})

      await ubaToken.approve(hodlerVault.address, tokensAmount, {from: USER});

      await expectRevert(
        hodlerVault.purchaseLP(0, {from: USER}),
        'HodlerVault: UBA required to mint LP'
      );
    });

    it('should NOT be possible to purchaseLP if user does not have enough UBA tokens', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const tokensAmount = bn('500').mul(baseUnit);

      await hodlerVault.sendTransaction({value: bn('11').mul(baseUnit)})

      await ubaToken.approve(hodlerVault.address, tokensAmount, {from: USER});

      await expectRevert(
        hodlerVault.purchaseLP(tokensAmount, {from: USER}),
        'HodlerVault: Not enough UBA tokens'
      );
    });

    it('should NOT be possible to purchaseLP if user did not do approve to spend UBA on hodlerVault', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const tokensAmount = bn('500').mul(baseUnit);

      await hodlerVault.sendTransaction({value: bn('11').mul(baseUnit)})

      await ubaToken.transfer(USER, tokensAmount);

      await expectRevert(
        hodlerVault.purchaseLP(tokensAmount, {from: USER}),
        'HodlerVault: Not enough UBA tokens allowance'
      );
    });

    it('should NOT be possible to purchaseLP if there is not enough ETH on hodlerVault balance', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const tokensAmount = bn('500').mul(baseUnit);

      await ubaToken.transfer(USER, tokensAmount);

      await ubaToken.approve(hodlerVault.address, tokensAmount, {from: USER});

      assertBNequal(await hodlerVault.lockedLPLength(USER), 0);
      assertBNequal(await pair.balanceOf(hodlerVault.address), 0);

      await expectRevert(
        hodlerVault.purchaseLP(tokensAmount, {from: USER}),
        'HodlerVault: insufficient ETH on HodlerVault'
      );
    });

  });

  describe('maxTokensToInvest', async () => {
    it('should return max amount of tokens allowed to deposit via maxTokensToInvest, if ETH is present on hodlerVault', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      await hodlerVault.sendTransaction({value: bn('11').mul(baseUnit)});

      const maxTokens = await hodlerVault.maxTokensToInvest();
      assertBNequal(maxTokens, bn('11000').mul(baseUnit));
    });

    it('should return 0 amount of tokens allowed to deposit via maxTokensToInvest, if ETH is not present on hodlerVault', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const maxTokens = await hodlerVault.maxTokensToInvest();
      assertBNequal(maxTokens, 0);
    });

  });

  describe('Claim LP', async () => {
    it('should be possible to claim LP if already unlocked', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const tokensAmount = bn('500').mul(baseUnit);

      await ubaToken.transfer(USER, tokensAmount);

      await hodlerVault.sendTransaction({value: bn('11').mul(baseUnit)})

      await ubaToken.approve(hodlerVault.address, tokensAmount, {from: USER});

      await ganache.setTime(startTime);
      await hodlerVault.purchaseLP(tokensAmount, {from: USER});
      const lpLocked = '15811388300841896659';

      const claimTime = bn(startTime).add(bn(lockTime)).add(bn(1)).toString();
      await ganache.setTime(claimTime);

      assertBNequal(await pair.balanceOf(USER), 0);
      assertBNequal(await pair.balanceOf(hodlerVault.address), lpLocked);

      let lockedLPObj = await hodlerVault.getLockedLP(USER, 0);
      assert.isFalse(lockedLPObj[3]);

      const result = await hodlerVault.claimLP({from: USER});

      assertBNequal(await pair.balanceOf(hodlerVault.address), 0);
      assertBNequal(await pair.balanceOf(USER), lpLocked);

      expectEvent(result, 'LPClaimed', {
        hodler: USER,
        amount: lpLocked
      });

      lockedLPObj = await hodlerVault.getLockedLP(USER, 0);
      assert.isTrue(lockedLPObj[3]);
    });

    it('should NOT be possible to claim LP if already unlocked (2 diff users locked LPs)', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const tokensAmount = bn('500').mul(baseUnit);

      await ubaToken.transfer(USER, tokensAmount);
      await ubaToken.transfer(USER_2, tokensAmount);

      await hodlerVault.sendTransaction({value: bn('11').mul(baseUnit)})

      await ubaToken.approve(hodlerVault.address, tokensAmount, {from: USER});
      await ubaToken.approve(hodlerVault.address, tokensAmount, {from: USER_2});

      await ganache.setTime(startTime);
      await hodlerVault.purchaseLP(tokensAmount, {from: USER});
      const lpLocked = '15811388300841896659';

      await hodlerVault.purchaseLP(tokensAmount, {from: USER_2});

      const claimTime = bn(startTime).add(bn(lockTime)).add(bn(100)).toString();
      await ganache.setTime(claimTime);

      assertBNequal(await pair.balanceOf(USER), 0);

      let lockedLPObj = await hodlerVault.getLockedLP(USER, 0);
      assert.isFalse(lockedLPObj[3]);

      const result = await hodlerVault.claimLP({from: USER});

      assertBNequal(await pair.balanceOf(USER), lpLocked);

      expectEvent(result, 'LPClaimed', {
        hodler: USER,
        amount: lpLocked
      });

      lockedLPObj = await hodlerVault.getLockedLP(USER, 0);
      assert.isTrue(lockedLPObj[3]);

      await expectRevert(
        hodlerVault.claimLP({from: USER}),
        'HodlerVault: nothing to claim.'
      );

      lockedLPObj = await hodlerVault.getLockedLP(USER_2, 0);
      assert.isFalse(lockedLPObj[3]);
    });

    it('should NOT be possible to claim LP if user did not deposit', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const tokensAmount = bn('500').mul(baseUnit);

      await ubaToken.transfer(USER, tokensAmount);
      await ubaToken.transfer(USER_2, tokensAmount);

      await hodlerVault.sendTransaction({value: bn('11').mul(baseUnit)})

      await ubaToken.approve(hodlerVault.address, tokensAmount, {from: USER});

      await ganache.setTime(startTime);
      await hodlerVault.purchaseLP(tokensAmount, {from: USER});

      const claimTime = bn(startTime).add(bn(lockTime)).add(bn(100)).toString();
      await ganache.setTime(claimTime);

      await expectRevert(
        hodlerVault.claimLP({from: USER_2}),
        'HodlerVault: nothing to claim.'
      );

      lockedLPObj = await hodlerVault.getLockedLP(USER, 0);
      assert.isFalse(lockedLPObj[3]);
    });

    it('should NOT be possible to claim LP if still locked', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const tokensAmount = bn('500').mul(baseUnit);

      await ubaToken.transfer(USER, tokensAmount);

      await hodlerVault.sendTransaction({value: bn('11').mul(baseUnit)})

      await ubaToken.approve(hodlerVault.address, tokensAmount, {from: USER});

      await ganache.setTime(startTime);
      await hodlerVault.purchaseLP(tokensAmount, {from: USER});
      const lpLocked = '15811388300841896659';

      const notClaimTime = bn(startTime).add(bn(lockTime)).sub(bn(10)).toString();
      await ganache.setTime(notClaimTime);

      await expectRevert(
        hodlerVault.claimLP({from: USER}),
        'HodlerVault: LP still locked.'
      );

    });

    it('should be possible to claim LP if already unlocked and user has multiple locks', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const tokensAmount = bn('500').mul(baseUnit);

      await ubaToken.transfer(USER, tokensAmount.mul(bn('10')));

      await hodlerVault.sendTransaction({value: bn('11').mul(baseUnit)})

      await ubaToken.approve(hodlerVault.address, tokensAmount.mul(bn('10')), {from: USER});

      await ganache.setTime(startTime);
      await hodlerVault.purchaseLP(tokensAmount, {from: USER});
      await hodlerVault.purchaseLP(tokensAmount, {from: USER});
      await hodlerVault.purchaseLP(tokensAmount, {from: USER});
      await hodlerVault.purchaseLP(tokensAmount, {from: USER});
      await hodlerVault.purchaseLP(tokensAmount, {from: USER});
      const lpLocked = '15811388300841896659';

      const claimTime = bn(startTime).add(bn(lockTime)).add(bn(10)).toString();
      await ganache.setTime(claimTime);

      assertBNequal(await pair.balanceOf(USER), 0);

      let lockedLPObj = await hodlerVault.getLockedLP(USER, 0);
      assert.isFalse(lockedLPObj[3]);

      let result = await hodlerVault.claimLP({from: USER});

      expectEvent(result, 'LPClaimed', {
        hodler: USER,
        amount: lpLocked
      });
      lockedLPObj = await hodlerVault.getLockedLP(USER, 0);
      assert.isTrue(lockedLPObj[3]);

      result = await hodlerVault.claimLP({from: USER});

      expectEvent(result, 'LPClaimed', {
        hodler: USER
      });
      lockedLPObj = await hodlerVault.getLockedLP(USER, 1);
      assert.isTrue(lockedLPObj[3]);

      result = await hodlerVault.claimLP({from: USER});

      expectEvent(result, 'LPClaimed', {
        hodler: USER
      });
      lockedLPObj = await hodlerVault.getLockedLP(USER, 2);
      assert.isTrue(lockedLPObj[3]);

      result = await hodlerVault.claimLP({from: USER});

      expectEvent(result, 'LPClaimed', {
        hodler: USER
      });
      lockedLPObj = await hodlerVault.getLockedLP(USER, 3);
      assert.isTrue(lockedLPObj[3]);

      result = await hodlerVault.claimLP({from: USER});

      expectEvent(result, 'LPClaimed', {
        hodler: USER
      });
      lockedLPObj = await hodlerVault.getLockedLP(USER, 4);
      assert.isTrue(lockedLPObj[3]);
    });

    it('should be possible to claim LP any time if force unlock is enabled', async () => {
      const liquidityTokensAmount = bn('10000').mul(baseUnit); // 10.000 tokens
      const liquidityEtherAmount = bn('10').mul(baseUnit); // 10 ETH

      await ubaToken.approve(uniswapRouter.address, liquidityTokensAmount);

      await uniswapRouter.addLiquidityETH(
        ubaToken.address,
        liquidityTokensAmount,
        0,
        0,
        OWNER,
        new Date().getTime() + 3000,
        {value: liquidityEtherAmount}
      );

      const tokensAmount = bn('500').mul(baseUnit);

      await ubaToken.transfer(USER, tokensAmount);

      await hodlerVault.sendTransaction({value: bn('11').mul(baseUnit)})

      await ubaToken.approve(hodlerVault.address, tokensAmount, {from: USER});

      await ganache.setTime(startTime);
      await hodlerVault.purchaseLP(tokensAmount, {from: USER});
      const lpLocked = '15811388300841896659';

      const notClaimTime = bn(startTime).add(bn(lockTime)).sub(bn(1000)).toString();
      await ganache.setTime(notClaimTime);

      assertBNequal(await pair.balanceOf(USER), 0);
      assertBNequal(await pair.balanceOf(hodlerVault.address), lpLocked);

      let lockedLPObj = await hodlerVault.getLockedLP(USER, 0);
      assert.isFalse(lockedLPObj[3]);

      await expectRevert(
        hodlerVault.claimLP({from: USER}),
        'HodlerVault: LP still locked.'
      );

      await hodlerVault.enableLPForceUnlock();

      const result = await hodlerVault.claimLP({from: USER});

      assertBNequal(await pair.balanceOf(hodlerVault.address), 0);
      assertBNequal(await pair.balanceOf(USER), lpLocked);

      expectEvent(result, 'LPClaimed', {
        hodler: USER,
        amount: lpLocked
      });

      lockedLPObj = await hodlerVault.getLockedLP(USER, 0);
      assert.isTrue(lockedLPObj[3]);
    });

  });

  describe('Admin functions', async () => {
    it('should be possible to seed more than 1 time for owner', async () => {
      let config = await hodlerVault.config();
      assert.equal(config.ubaToken, ubaToken.address);
      assert.equal(config.tokenPair, uniswapPair);
      assert.equal(config.uniswapRouter, uniswapRouter.address);
      assert.equal(config.weth, weth.address);
      assertBNequal(config.stakeDuration, 86400);
      assert.equal(config.feeReceiver, FEE_RECEIVER);
      assertBNequal(config.purchaseFee, 0);

      const fakeAddress = accounts[6];
      await hodlerVault.seed(
        5,
        fakeAddress,
        fakeAddress,
        uniswapRouter.address,
        USER,
        10
      );

      config = await hodlerVault.config();
      assert.equal(config.ubaToken, fakeAddress);
      assert.equal(config.tokenPair, fakeAddress);
      assert.equal(config.uniswapRouter, uniswapRouter.address);
      assert.equal(config.weth, weth.address);
      assertBNequal(config.stakeDuration, 5 * 86400);
      assert.equal(config.feeReceiver, USER);
      assertBNequal(config.purchaseFee, 10);

    });

    it('should NOT be possible to seed for NOT owner', async () => {
      const fakeAddress = accounts[6];
      await expectRevert(
        hodlerVault.seed(
          5,
          fakeAddress,
          fakeAddress,
          uniswapRouter.address,
          USER,
          10,
          {from: NOT_OWNER}
        ),
        'Ownable: caller is not the owner.'
      );

    });

    it('should be possible to setParameters', async () => {
      let config = await hodlerVault.config();
      assertBNequal(config.stakeDuration, 86400);
      assertBNequal(config.donationShare, 0);

      await hodlerVault.setParameters(2, 50, 60);

      config = await hodlerVault.config();
      assertBNequal(config.stakeDuration, 2 * 86400);
      assertBNequal(config.donationShare, 50);
      assertBNequal(config.purchaseFee, 60);
    });

    it('should NOT be possible to setDuration for NOT owner', async () => {
      await expectRevert(
        hodlerVault.setParameters(2, 50, 60, {from: NOT_OWNER}),
        'Ownable: caller is not the owner.'
      );
    });

    it('should not set fee receiver address from non-owner', async () => {
      const newFeeReceiver = accounts[7];

      await expectRevert(
        hodlerVault.setFeeReceiver(newFeeReceiver, { from: NOT_OWNER }),
        'Ownable: caller is not the owner'
      );
    });

    it('should set fee receiver address', async () => {
      const newFeeReceiver = accounts[7];
      await hodlerVault.setFeeReceiver(newFeeReceiver);
      assert.equal((await hodlerVault.config()).feeReceiver, newFeeReceiver);
    });

    it('should be possible to enableLPForceUnlock', async () => {
      assert.isFalse(await hodlerVault.forceUnlock())
      await hodlerVault.enableLPForceUnlock();
      assert.isTrue(await hodlerVault.forceUnlock())
    });

    it('should NOT be possible to enableLPForceUnlock for NOT owner', async () => {
      await expectRevert(
        hodlerVault.enableLPForceUnlock({from: NOT_OWNER}),
        'Ownable: caller is not the owner.'
      );
    });

  });

});
