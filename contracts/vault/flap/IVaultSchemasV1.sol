// SPDX-License-Identifier: MIT
pragma solidity ^0.8.13;

// -----------------------------------------------------------------------------
// 本文件按 FLAP 官方 Vault & VaultFactory Specification 原样转录。
// 来源：docs.flap.sh/en/flap/developers/vault-developers/vault-and-vaultfactory-specification
// 若 FLAP 发布了官方 npm 包，应替换为官方依赖，不要维护这份副本。
// -----------------------------------------------------------------------------

/// @notice Describes a single field (parameter, return value, or vault-data component).
/// @param name        Machine-readable name, e.g. "recipient", "bps", "amount".
/// @param fieldType   Solidity ABI type string, e.g. "string", "address", "uint256".
///                    The special value "time" is an alias for "uint256" whose encoded value
///                    is a Unix timestamp in seconds.
///                    The special value "msg.value" indicates the field is the native
///                    currency amount (wei) sent with the transaction.
/// @param description Human-readable explanation shown as a label or tooltip.
/// @param decimals    Decimal precision hint for numeric fields.
struct FieldDescriptor {
    string name;
    string fieldType;
    string description;
    uint8 decimals;
}

/// @notice Describes the shape of the `vaultData` bytes expected by a factory's `newVault()`.
struct VaultDataSchema {
    string description;
    FieldDescriptor[] fields;
    bool isArray;
}

/// @notice An ERC-20 `approve` action the UI must execute before calling a write method.
/// @dev    The spender is always the vault contract itself.
struct ApproveAction {
    string tokenType;
    string amountFieldName;
}

/// @notice Describes a single view or write method the UI should render for a vault.
struct VaultMethodSchema {
    string name;
    string description;
    FieldDescriptor[] inputs;
    FieldDescriptor[] outputs;
    ApproveAction[] approvals;
    bool isInputArray;
    bool isOutputArray;
    bool isWriteMethod;
}

/// @notice Top-level schema describing the vault's entire UI surface.
///         Returned by `VaultBaseV2.vaultUISchema()`.
struct VaultUISchema {
    string vaultType;
    string description;
    VaultMethodSchema[] methods;
}

/// @notice A single constraint the factory enforces on the normalized launch validation
///         payload. Informational only.
struct FactoryPolicy {
    string target;
    string operator;
    bytes value;
    string description;
}
