// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

import {VaultUISchema} from "./IVaultSchemasV1.sol";

// -----------------------------------------------------------------------------
// 本文件按 FLAP 官方 Vault & VaultFactory Specification 原样转录。
// 来源：docs.flap.sh/en/flap/developers/vault-developers/vault-and-vaultfactory-specification
// 若 FLAP 发布了官方 npm 包，应替换为官方依赖，不要维护这份副本。
// -----------------------------------------------------------------------------

/// @title VaultBase
/// @notice Abstract base contract for all vault implementations
/// @author The Flap Team
abstract contract VaultBase {
    /// @notice Error thrown when the current chain is not supported
    error UnsupportedChain(uint256 chainId);

    /// @notice Get the Portal address for the current chain
    /// @dev Currently supports BNB Chain (56), BNB Testnet (97), and Robinhood Chain (4663)
    /// @return portal The Portal contract address
    function _getPortal() internal view returns (address portal) {
        uint256 chainId = block.chainid;
        if (chainId == 56) {
            // BNB Chain Portal
            return 0xe2cE6ab80874Fa9Fa2aAE65D277Dd6B8e65C9De0;
        } else if (chainId == 97) {
            // BNB Testnet Portal
            return 0x5bEacaF7ABCbB3aB280e80D007FD31fcE26510e9;
        } else if (chainId == 4663) {
            // Robinhood Chain Portal
            return 0x26605f322f7fF986f381bB9A6e3f5DAb0bEaEb09;
        }
        revert UnsupportedChain(chainId);
    }

    /// @notice Get the Guardian address for the current chain
    /// @dev Currently supports BNB Chain (56), BNB Testnet (97), and Robinhood Chain (4663)
    /// @return guardian The Guardian contract address
    function _getGuardian() internal view returns (address guardian) {
        uint256 chainId = block.chainid;
        if (chainId == 56) {
            // BNB Chain Guardian address
            return 0x9e27098dcD8844bcc6287a557E0b4D09C86B8a4b;
        } else if (chainId == 97) {
            // BNB Testnet Guardian address
            return 0x76Fa8C526f8Bc27ba6958B76DeEf92a0dbE46950;
        } else if (chainId == 4663) {
            // Robinhood Chain Guardian address
            return 0x0000b48720d3B4ED6BC5031768B07F2b59270000;
        }
        revert UnsupportedChain(chainId);
    }

    /// @notice Returns a description of the vault
    /// @dev Must be overridden to provide a dynamic description based on the vault's current state
    /// @return A string describing the vault's current state and configuration
    function description() public view virtual returns (string memory);
}

/// @title VaultBaseV2
/// @author The Flap Team
/// @notice Extended abstract base contract for vault implementations that adds
///         on-chain UI schema discovery via `vaultUISchema()`.
abstract contract VaultBaseV2 is VaultBase {
    /// @notice Returns the UI schema describing which methods the UI should
    ///         render for this vault.
    /// @return schema The complete UI schema for this vault.
    function vaultUISchema() public pure virtual returns (VaultUISchema memory schema);
}

/// @title VaultBaseV3
/// @author The Flap Team
/// @notice Extended abstract base contract for vault implementations that adds
///         support for ERC20 quote tokens as the vault's revenue currency, via
///         `vaultQuoteToken()` discovery and a normative balance-delta accounting model.
abstract contract VaultBaseV3 is VaultBaseV2 {
    /// @notice The revenue currency this vault accounts for.
    /// @dev MUST equal the quote token of the tax token this vault serves:
    ///      `address(0)` for the native gas token, the ERC20 address
    ///      otherwise. MUST be stable for the life of the vault and MUST NOT revert.
    /// @return quoteToken The revenue currency (`address(0)` = native).
    function vaultQuoteToken() public view virtual returns (address quoteToken);

    /// @notice The vault-side spec revision this implementation conforms to.
    /// @return The spec version string, "v3" for this revision.
    function vaultSpecVersion() public pure virtual returns (string memory) {
        return "v3";
    }
}
