const { expect } = require("chai");
const { ethers } = require("hardhat");

const PRICE_SCALE = 10n ** 8n;
const SIDE_BID = 0;
const SIDE_ASK = 1;

// EIP-712 Order type, field order matches the protocol spec type string:
// "Order(address trader,address baseToken,address quoteToken,uint8 side,
//  uint256 price,uint256 qty,uint256 nonce,uint256 expiry)"
const ORDER_TYPES = {
  Order: [
    { name: "trader", type: "address" },
    { name: "baseToken", type: "address" },
    { name: "quoteToken", type: "address" },
    { name: "side", type: "uint8" },
    { name: "price", type: "uint256" },
    { name: "qty", type: "uint256" },
    { name: "nonce", type: "uint256" },
    { name: "expiry", type: "uint256" },
  ],
};

const tokens = (n) => ethers.parseUnits(n.toString(), 18);
const priceOf = (n) => BigInt(n) * PRICE_SCALE;
// quote_amount = qty * price / 1e8, integer division, rounds down.
const quoteAmount = (qty, price) => (qty * price) / PRICE_SCALE;

async function deployStack() {
  const [deployer, bidder, asker] = await ethers.getSigners();
  const baseNonce = await ethers.provider.getTransactionCount(deployer.address);
  const settlementAddress = ethers.getCreateAddress({
    from: deployer.address,
    nonce: baseNonce + 1,
  });

  const Vault = await ethers.getContractFactory("Vault");
  const vault = await Vault.deploy(settlementAddress);
  await vault.waitForDeployment();

  const Settlement = await ethers.getContractFactory("Settlement");
  const settlement = await Settlement.deploy(await vault.getAddress());
  await settlement.waitForDeployment();

  const TestToken = await ethers.getContractFactory("TestToken");
  const base = await TestToken.deploy("Base Token", "BASE");
  await base.waitForDeployment();
  const quote = await TestToken.deploy("Quote Token", "QUOTE");
  await quote.waitForDeployment();

  return {
    deployer,
    bidder,
    asker,
    vault,
    settlement,
    base,
    quote,
    baseAddr: await base.getAddress(),
    quoteAddr: await quote.getAddress(),
    settlementAddr: await settlement.getAddress(),
    vaultAddr: await vault.getAddress(),
  };
}

async function latestTimestamp() {
  const block = await ethers.provider.getBlock("latest");
  return BigInt(block.timestamp);
}

describe("OpenBook settlement", function () {
  let deployer, bidder, asker, vault, settlement, base, quote;
  let baseAddr, quoteAddr, settlementAddr, vaultAddr, chainId, domain;

  beforeEach(async function () {
    ({
      deployer,
      bidder,
      asker,
      vault,
      settlement,
      base,
      quote,
      baseAddr,
      quoteAddr,
      settlementAddr,
      vaultAddr,
    } = await deployStack());
    chainId = (await ethers.provider.getNetwork()).chainId;
    domain = {
      name: "OpenBook",
      version: "1",
      chainId,
      verifyingContract: settlementAddr,
    };
  });

  function makeOrder(trader, side, price, qty, nonce, expiry) {
    return {
      trader: trader.address,
      baseToken: baseAddr,
      quoteToken: quoteAddr,
      side,
      price,
      qty,
      nonce,
      expiry,
    };
  }

  async function sign(signer, order) {
    return signer.signTypedData(domain, ORDER_TYPES, order);
  }

  async function fund(user, token, tokenAddr, amount) {
    await token.mint(user.address, amount);
    await token.connect(user).approve(vaultAddr, amount);
    await vault.connect(user).deposit(tokenAddr, amount);
  }

  // Builds a fully signed fill: bidder bids at bidPrice, asker asks at
  // askPrice, execution happens at fillPrice for qty.
  async function signedFill({
    bidPrice,
    askPrice,
    fillPrice,
    qty,
    bidNonce = 1n,
    askNonce = 1n,
    expiryOffset = 3600n,
  }) {
    const expiry = (await latestTimestamp()) + expiryOffset;
    const bid = makeOrder(bidder, SIDE_BID, bidPrice, qty, bidNonce, expiry);
    const ask = makeOrder(asker, SIDE_ASK, askPrice, qty, askNonce, expiry);
    return {
      bid,
      ask,
      bidSig: await sign(bidder, bid),
      askSig: await sign(asker, ask),
      price: fillPrice,
      qty,
    };
  }

  describe("Vault", function () {
    it("deposit pulls tokens and credits the user balance", async function () {
      const amount = tokens(1000);
      await base.mint(bidder.address, amount);
      await base.connect(bidder).approve(vaultAddr, amount);

      await expect(vault.connect(bidder).deposit(baseAddr, amount))
        .to.emit(vault, "Deposited")
        .withArgs(bidder.address, baseAddr, amount);

      expect(await vault.balanceOf(bidder.address, baseAddr)).to.equal(amount);
      expect(await base.balanceOf(vaultAddr)).to.equal(amount);
    });

    it("withdraw returns tokens and debits the user balance", async function () {
      await fund(bidder, base, baseAddr, tokens(1000));

      await expect(vault.connect(bidder).withdraw(baseAddr, tokens(400)))
        .to.emit(vault, "Withdrawn")
        .withArgs(bidder.address, baseAddr, tokens(400));

      expect(await vault.balanceOf(bidder.address, baseAddr)).to.equal(tokens(600));
      expect(await base.balanceOf(bidder.address)).to.equal(tokens(400));
    });

    it("withdraw reverts when the balance is insufficient", async function () {
      await fund(bidder, base, baseAddr, tokens(100));
      await expect(
        vault.connect(bidder).withdraw(baseAddr, tokens(101))
      ).to.be.revertedWithCustomError(vault, "InsufficientBalance");
    });

    it("move reverts when called by anyone except Settlement", async function () {
      await expect(
        vault.connect(bidder).move(bidder.address, asker.address, baseAddr, 1n)
      ).to.be.revertedWithCustomError(vault, "OnlySettlement");
    });
  });

  describe("settle", function () {
    it("settles one fill and updates balances exactly", async function () {
      const qty = tokens(2);
      const fill = await signedFill({
        bidPrice: priceOf(100),
        askPrice: priceOf(95),
        fillPrice: priceOf(98),
        qty,
      });
      const qa = quoteAmount(qty, fill.price); // 2 * 98 = 196 quote tokens

      await fund(bidder, quote, quoteAddr, tokens(1000));
      await fund(asker, base, baseAddr, tokens(10));

      await expect(settlement.settle([fill]))
        .to.emit(settlement, "Settled")
        .withArgs(bidder.address, asker.address, baseAddr, quoteAddr, fill.price, qty);

      expect(await vault.balanceOf(bidder.address, baseAddr)).to.equal(qty);
      expect(await vault.balanceOf(bidder.address, quoteAddr)).to.equal(tokens(1000) - qa);
      expect(await vault.balanceOf(asker.address, baseAddr)).to.equal(tokens(10) - qty);
      expect(await vault.balanceOf(asker.address, quoteAddr)).to.equal(qa);

      expect(await settlement.usedNonce(bidder.address, 1n)).to.equal(true);
      expect(await settlement.usedNonce(asker.address, 1n)).to.equal(true);
    });

    it("settles multiple fills in one batch", async function () {
      const qty = tokens(1);
      await fund(bidder, quote, quoteAddr, tokens(1000));
      await fund(asker, base, baseAddr, tokens(10));

      const fill1 = await signedFill({
        bidPrice: priceOf(100),
        askPrice: priceOf(95),
        fillPrice: priceOf(98),
        qty,
        bidNonce: 1n,
        askNonce: 1n,
      });
      const fill2 = await signedFill({
        bidPrice: priceOf(100),
        askPrice: priceOf(95),
        fillPrice: priceOf(97),
        qty,
        bidNonce: 2n,
        askNonce: 2n,
      });

      await settlement.settle([fill1, fill2]);

      const qa = quoteAmount(qty, fill1.price) + quoteAmount(qty, fill2.price);
      expect(await vault.balanceOf(bidder.address, baseAddr)).to.equal(qty * 2n);
      expect(await vault.balanceOf(bidder.address, quoteAddr)).to.equal(tokens(1000) - qa);
      expect(await vault.balanceOf(asker.address, quoteAddr)).to.equal(qa);
    });

    it("reverts on a bad signature", async function () {
      const qty = tokens(2);
      const fill = await signedFill({
        bidPrice: priceOf(100),
        askPrice: priceOf(95),
        fillPrice: priceOf(98),
        qty,
      });
      await fund(bidder, quote, quoteAddr, tokens(1000));
      await fund(asker, base, baseAddr, tokens(10));

      // Tamper with the signed order: the signature no longer matches.
      const tampered = { ...fill, bid: { ...fill.bid, price: priceOf(101) } };
      await expect(settlement.settle([tampered])).to.be.revertedWithCustomError(
        settlement,
        "BadSignature"
      );
    });

    it("reverts when the bidder lacks quote balance", async function () {
      const qty = tokens(2);
      const fill = await signedFill({
        bidPrice: priceOf(100),
        askPrice: priceOf(95),
        fillPrice: priceOf(98),
        qty,
      });
      await fund(bidder, quote, quoteAddr, tokens(100)); // needs 196
      await fund(asker, base, baseAddr, tokens(10));

      await expect(settlement.settle([fill])).to.be.revertedWithCustomError(
        settlement,
        "InsufficientBalance"
      );
    });

    it("reverts when the asker lacks base balance", async function () {
      const qty = tokens(2);
      const fill = await signedFill({
        bidPrice: priceOf(100),
        askPrice: priceOf(95),
        fillPrice: priceOf(98),
        qty,
      });
      await fund(bidder, quote, quoteAddr, tokens(1000));
      await fund(asker, base, baseAddr, tokens(1)); // needs 2

      await expect(settlement.settle([fill])).to.be.revertedWithCustomError(
        settlement,
        "InsufficientBalance"
      );
    });

    it("reverts when a nonce is replayed", async function () {
      const qty = tokens(2);
      const fill = await signedFill({
        bidPrice: priceOf(100),
        askPrice: priceOf(95),
        fillPrice: priceOf(98),
        qty,
      });
      await fund(bidder, quote, quoteAddr, tokens(1000));
      await fund(asker, base, baseAddr, tokens(10));

      await settlement.settle([fill]);

      // Same fill again: both nonces are now used.
      await expect(settlement.settle([fill])).to.be.revertedWithCustomError(
        settlement,
        "NonceAlreadyUsed"
      );
      // Same nonces inside one batch also revert.
      await expect(settlement.settle([fill, fill])).to.be.revertedWithCustomError(
        settlement,
        "NonceAlreadyUsed"
      );
    });

    it("reverts on an expired order", async function () {
      const qty = tokens(2);
      const fill = await signedFill({
        bidPrice: priceOf(100),
        askPrice: priceOf(95),
        fillPrice: priceOf(98),
        qty,
        expiryOffset: -100n,
      });
      await fund(bidder, quote, quoteAddr, tokens(1000));
      await fund(asker, base, baseAddr, tokens(10));

      await expect(settlement.settle([fill])).to.be.revertedWithCustomError(
        settlement,
        "OrderExpired"
      );
    });

    it("reverts when the fill price is above the bid limit", async function () {
      const qty = tokens(2);
      const fill = await signedFill({
        bidPrice: priceOf(100),
        askPrice: priceOf(95),
        fillPrice: priceOf(101),
        qty,
      });
      await fund(bidder, quote, quoteAddr, tokens(1000));
      await fund(asker, base, baseAddr, tokens(10));

      await expect(settlement.settle([fill])).to.be.revertedWithCustomError(
        settlement,
        "PriceOutOfRange"
      );
    });

    it("reverts when the fill price is below the ask limit", async function () {
      const qty = tokens(2);
      const fill = await signedFill({
        bidPrice: priceOf(100),
        askPrice: priceOf(95),
        fillPrice: priceOf(94),
        qty,
      });
      await fund(bidder, quote, quoteAddr, tokens(1000));
      await fund(asker, base, baseAddr, tokens(10));

      await expect(settlement.settle([fill])).to.be.revertedWithCustomError(
        settlement,
        "PriceOutOfRange"
      );
    });

    it("reverts on token mismatch between the two orders", async function () {
      const qty = tokens(2);
      const expiry = (await latestTimestamp()) + 3600n;
      const bid = makeOrder(bidder, SIDE_BID, priceOf(100), qty, 1n, expiry);

      const Other = await ethers.getContractFactory("TestToken");
      const other = await Other.deploy("Other Base", "OBASE2");
      await other.waitForDeployment();
      const ask = {
        trader: asker.address,
        baseToken: await other.getAddress(),
        quoteToken: quoteAddr,
        side: SIDE_ASK,
        price: priceOf(95),
        qty,
        nonce: 1n,
        expiry,
      };

      const fill = {
        bid,
        ask,
        bidSig: await sign(bidder, bid),
        askSig: await sign(asker, ask),
        price: priceOf(98),
        qty,
      };

      await expect(settlement.settle([fill])).to.be.revertedWithCustomError(
        settlement,
        "TokenMismatch"
      );
    });

    it("reverts when the bid order is not a bid", async function () {
      const qty = tokens(2);
      const expiry = (await latestTimestamp()) + 3600n;
      const bid = makeOrder(bidder, SIDE_ASK, priceOf(100), qty, 1n, expiry); // wrong side
      const ask = makeOrder(asker, SIDE_ASK, priceOf(95), qty, 1n, expiry);
      const fill = {
        bid,
        ask,
        bidSig: await sign(bidder, bid),
        askSig: await sign(asker, ask),
        price: priceOf(98),
        qty,
      };

      await expect(settlement.settle([fill])).to.be.revertedWithCustomError(
        settlement,
        "InvalidBidSide"
      );
    });
  });
});
