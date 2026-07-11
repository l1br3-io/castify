//! Provider registry — the single dispatch point over the `Provider` enum.
//!
//! `ProviderRegistry` owns each provider's OAuth config. `factory_for(provider)`
//! returns a boxed `ProviderFactory` for configured providers, replacing the
//! `match provider {}` dispatch that previously lived in `connections.rs`.
//!
//! Construction from `castify_core::Config` happens in the api crate (which
//! depends on both core and catalog) to avoid coupling catalog → core.

pub mod common;
pub mod dropbox;
pub mod google_drive;
pub mod onedrive;

use crate::model::Provider;
use crate::provider::ProviderFactory;
use dropbox::{DropboxConfig, DropboxFactory};
use google_drive::{GoogleDriveConfig, GoogleDriveFactory};
use onedrive::{OneDriveConfig, OneDriveFactory};

/// Registry of configured provider factories. Built once at app startup from
/// the resolved `Config`; cloned cheaply into handlers via `AppState`.
#[derive(Debug, Clone, Default)]
pub struct ProviderRegistry {
    google: Option<GoogleDriveConfig>,
    dropbox: Option<DropboxConfig>,
    onedrive: Option<OneDriveConfig>,
}

impl ProviderRegistry {
    pub fn new(
        google: Option<GoogleDriveConfig>,
        dropbox: Option<DropboxConfig>,
        onedrive: Option<OneDriveConfig>,
    ) -> Self {
        Self {
            google,
            dropbox,
            onedrive,
        }
    }

    /// Returns true if the provider's OAuth credentials are configured.
    pub fn is_configured(&self, provider: Provider) -> bool {
        match provider {
            Provider::GoogleDrive => self.google.is_some(),
            Provider::Dropbox => self.dropbox.is_some(),
            Provider::OneDrive => self.onedrive.is_some(),
        }
    }

    /// Build a `ProviderFactory` for `provider`, or `None` if it is not
    /// configured. This is the single dispatch point over the `Provider` enum —
    /// callers use the returned trait object and never match on the provider
    /// themselves.
    pub fn factory_for(&self, provider: Provider) -> Option<Box<dyn ProviderFactory>> {
        match provider {
            Provider::GoogleDrive => {
                self.google
                    .clone()
                    .map(|cfg| Box::new(GoogleDriveFactory::new(cfg)) as Box<dyn ProviderFactory>)
            }
            Provider::Dropbox => {
                self.dropbox
                    .clone()
                    .map(|cfg| Box::new(DropboxFactory::new(cfg)) as Box<dyn ProviderFactory>)
            }
            Provider::OneDrive => {
                self.onedrive
                    .clone()
                    .map(|cfg| Box::new(OneDriveFactory::new(cfg)) as Box<dyn ProviderFactory>)
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn google_cfg() -> GoogleDriveConfig {
        GoogleDriveConfig {
            client_id: "g-id".into(),
            client_secret: "g-secret".into(),
        }
    }
    fn dropbox_cfg() -> DropboxConfig {
        DropboxConfig {
            client_id: "d-id".into(),
            client_secret: "d-secret".into(),
        }
    }
    fn onedrive_cfg() -> OneDriveConfig {
        OneDriveConfig {
            client_id: "o-id".into(),
            client_secret: "o-secret".into(),
        }
    }

    #[test]
    fn empty_registry_reports_unconfigured() {
        let reg = ProviderRegistry::default();
        assert!(!reg.is_configured(Provider::GoogleDrive));
        assert!(!reg.is_configured(Provider::Dropbox));
        assert!(!reg.is_configured(Provider::OneDrive));
        assert!(reg.factory_for(Provider::GoogleDrive).is_none());
    }

    #[test]
    fn configured_provider_is_configured_and_builds_factory() {
        let reg = ProviderRegistry::new(Some(google_cfg()), None, None);
        assert!(reg.is_configured(Provider::GoogleDrive));
        assert!(!reg.is_configured(Provider::Dropbox));
        let factory = reg
            .factory_for(Provider::GoogleDrive)
            .expect("google configured");
        let url = factory.authorization_url("https://example.com/cb", "state", "challenge");
        assert!(url.contains("client_id=g-id"));
    }

    #[test]
    fn all_three_providers_build_factories() {
        let reg = ProviderRegistry::new(
            Some(google_cfg()),
            Some(dropbox_cfg()),
            Some(onedrive_cfg()),
        );
        for p in [
            Provider::GoogleDrive,
            Provider::Dropbox,
            Provider::OneDrive,
        ] {
            assert!(reg.is_configured(p), "{p:?} should be configured");
            assert!(
                reg.factory_for(p).is_some(),
                "{p:?} should produce a factory"
            );
        }
    }
}
