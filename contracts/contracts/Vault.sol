// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Vault
/// @notice Custody for ERC-20 deposits. Only the Settlement contract may move
///         balances between users; deposits and withdrawals are self-service.
contract Vault {
    using SafeERC20 for IERC20;

    error OnlySettlement(address caller);
    error InsufficientBalance(address user, address token, uint256 requested, uint256 available);

    event Deposited(address indexed user, address indexed token, uint256 amount);
    event Withdrawn(address indexed user, address indexed token, uint256 amount);
    event Moved(address indexed from, address indexed to, address indexed token, uint256 amount);

    /// @dev Address of the only contract allowed to move balances between users.
    address public immutable settlement;

    mapping(address => mapping(address => uint256)) private _balances;

    constructor(address settlement_) {
        settlement = settlement_;
    }

    /// @notice Deposit `amount` of `token` into the caller's vault balance.
    /// @dev The caller must approve the vault first.
    function deposit(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
        _balances[msg.sender][token] += amount;
        emit Deposited(msg.sender, token, amount);
    }

    /// @notice Withdraw `amount` of `token` back to the caller.
    function withdraw(address token, uint256 amount) external {
        uint256 bal = _balances[msg.sender][token];
        if (bal < amount) revert InsufficientBalance(msg.sender, token, amount, bal);
        unchecked {
            _balances[msg.sender][token] = bal - amount;
        }
        IERC20(token).safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, token, amount);
    }

    /// @notice Vault balance of `user` for `token`.
    function balanceOf(address user, address token) external view returns (uint256) {
        return _balances[user][token];
    }

    /// @notice Move `amount` of `token` from one user's balance to another's.
    /// @dev Callable only by the Settlement contract.
    function move(address from, address to, address token, uint256 amount) external {
        if (msg.sender != settlement) revert OnlySettlement(msg.sender);
        uint256 bal = _balances[from][token];
        if (bal < amount) revert InsufficientBalance(from, token, amount, bal);
        unchecked {
            _balances[from][token] = bal - amount;
        }
        _balances[to][token] += amount;
        emit Moved(from, to, token, amount);
    }
}
