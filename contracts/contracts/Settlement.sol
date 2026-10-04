// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

interface IVault {
    function move(address from, address to, address token, uint256 amount) external;
    function balanceOf(address user, address token) external view returns (uint256);
}

/// @title Settlement
/// @notice Verifies EIP-712 signed orders and settles matched fills against
///         the Vault. Matching itself is operator-run off-chain; this contract
///         only executes correctly signed, unexpired orders with sufficient
///         balances, so a malicious operator cannot steal funds.
contract Settlement is EIP712 {
    /// @dev keccak256 of the EIP-712 Order type string from the protocol spec.
    bytes32 private constant ORDER_TYPEHASH =
        keccak256(
            "Order(address trader,address baseToken,address quoteToken,uint8 side,uint256 price,uint256 qty,uint256 nonce,uint256 expiry)"
        );

    /// @dev 1e8, the price scaling factor from the protocol spec.
    uint256 private constant PRICE_SCALE = 1e8;

    uint8 private constant SIDE_BID = 0;
    uint8 private constant SIDE_ASK = 1;

    struct Order {
        address trader;
        address baseToken;
        address quoteToken;
        uint8 side; // 0 = bid, 1 = ask
        uint256 price; // quote per base, scaled 1e8
        uint256 qty; // base amount, smallest units
        uint256 nonce; // per-trader nonce, must be unused
        uint256 expiry; // unix timestamp, order invalid at/after this
    }

    struct Fill {
        Order bid;
        Order ask;
        bytes bidSig;
        bytes askSig;
        uint256 price; // execution price, scaled 1e8
        uint256 qty; // execution qty, base smallest units
    }

    error InvalidBidSide(uint8 side);
    error InvalidAskSide(uint8 side);
    error TokenMismatch(
        address bidBaseToken,
        address bidQuoteToken,
        address askBaseToken,
        address askQuoteToken
    );
    error BadSignature(address trader, address recovered);
    error NonceAlreadyUsed(address trader, uint256 nonce);
    error OrderExpired(address trader, uint256 expiry);
    error PriceOutOfRange(uint256 fillPrice, uint256 bidPrice, uint256 askPrice);
    error InsufficientBalance(address trader, address token, uint256 required, uint256 available);

    event Settled(
        address indexed bidTrader,
        address indexed askTrader,
        address indexed baseToken,
        address quoteToken,
        uint256 price,
        uint256 qty
    );

    IVault public immutable vault;

    /// @dev usedNonce[trader][nonce] is true once the nonce has been settled.
    mapping(address => mapping(uint256 => bool)) public usedNonce;

    constructor(address vault_) EIP712("OpenBook", "1") {
        vault = IVault(vault_);
    }

    /// @notice Settle a batch of fills. Each fill references two signed orders
    ///         and an execution price/qty. The whole batch reverts on the first
    ///         invalid fill.
    function settle(Fill[] calldata fills) external {
        for (uint256 i = 0; i < fills.length; i++) {
            _settleFill(fills[i]);
        }
    }

    function _settleFill(Fill calldata fill) internal {
        Order calldata bid = fill.bid;
        Order calldata ask = fill.ask;

        if (bid.side != SIDE_BID) revert InvalidBidSide(bid.side);
        if (ask.side != SIDE_ASK) revert InvalidAskSide(ask.side);
        if (bid.baseToken != ask.baseToken || bid.quoteToken != ask.quoteToken) {
            revert TokenMismatch(bid.baseToken, bid.quoteToken, ask.baseToken, ask.quoteToken);
        }

        _verifyOrder(bid, fill.bidSig);
        _verifyOrder(ask, fill.askSig);

        if (fill.price > bid.price || fill.price < ask.price) {
            revert PriceOutOfRange(fill.price, bid.price, ask.price);
        }

        // quote_amount = qty * price / 1e8, integer division, rounds down.
        uint256 quoteAmount = (fill.qty * fill.price) / PRICE_SCALE;

        uint256 bidQuoteBal = vault.balanceOf(bid.trader, bid.quoteToken);
        if (bidQuoteBal < quoteAmount) {
            revert InsufficientBalance(bid.trader, bid.quoteToken, quoteAmount, bidQuoteBal);
        }
        uint256 askBaseBal = vault.balanceOf(ask.trader, ask.baseToken);
        if (askBaseBal < fill.qty) {
            revert InsufficientBalance(ask.trader, ask.baseToken, fill.qty, askBaseBal);
        }

        usedNonce[bid.trader][bid.nonce] = true;
        usedNonce[ask.trader][ask.nonce] = true;

        vault.move(bid.trader, ask.trader, bid.quoteToken, quoteAmount);
        vault.move(ask.trader, bid.trader, ask.baseToken, fill.qty);

        emit Settled(bid.trader, ask.trader, bid.baseToken, bid.quoteToken, fill.price, fill.qty);
    }

    function _verifyOrder(Order calldata order, bytes calldata sig) internal view {
        if (usedNonce[order.trader][order.nonce]) {
            revert NonceAlreadyUsed(order.trader, order.nonce);
        }
        if (block.timestamp >= order.expiry) {
            revert OrderExpired(order.trader, order.expiry);
        }
        address recovered = ECDSA.recover(_hashTypedDataV4(_orderHash(order)), sig);
        if (recovered != order.trader) {
            revert BadSignature(order.trader, recovered);
        }
    }

    function _orderHash(Order calldata order) internal pure returns (bytes32) {
        return
            keccak256(
                abi.encode(
                    ORDER_TYPEHASH,
                    order.trader,
                    order.baseToken,
                    order.quoteToken,
                    order.side,
                    order.price,
                    order.qty,
                    order.nonce,
                    order.expiry
                )
            );
    }
}
