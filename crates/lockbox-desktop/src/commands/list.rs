/// Every Lockbox command the page may call. `build.rs` includes this file to generate one `allow-` permission per
/// command; `capabilities/main.json` grants each of them, and `tests/ipc.rs` checks the two agree.
pub const COMMANDS: &[&str] = &[
    "app_info",
    "list_sessions",
    "lock_vault",
    "lock_all",
    "list_vaults",
    "add_existing_vault",
    "add_existing_vault_confirm",
    "forget_vault",
    "create_vault",
    "create_vault_confirm",
    "unlock_vault",
    "recover_vault",
    "recover_vault_confirm",
    "change_password",
    "regenerate_recovery",
    "accept_header",
];
