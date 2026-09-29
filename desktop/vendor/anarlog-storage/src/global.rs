use std::path::{Path, PathBuf};

pub const VAULT_CONFIG_FILENAME: &str = "global.json";

pub fn compute_vault_config_path(base: &Path) -> PathBuf {
    base.join(VAULT_CONFIG_FILENAME)
}

pub fn compute_default_base(bundle_id: &str) -> Option<PathBuf> {
    let data_dir = dirs::data_dir()?;
    Some(data_dir.join(bundle_id))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn compute_vault_config_path_joins_global_json() {
        let temp = tempdir().unwrap();
        assert_eq!(
            compute_vault_config_path(temp.path()),
            temp.path().join("global.json")
        );
    }
}
