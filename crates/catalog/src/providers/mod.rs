//! Provider registry — the single dispatch point over the `Provider` enum.
//!
//! `ProviderRegistry` owns each provider's OAuth config. `factory_for(provider)`
//! returns a boxed `ProviderFactory` for configured providers, replacing the
//! `match provider {}` dispatch that previously lived in `connections.rs`.
//!
//! Construction from `castify_core::Config` happens in the api crate (which
//! depends on both core and catalog) to avoid coupling catalog → core.
//!
//! Adding a provider (OAuth or credential-based)? Follow the checklist in
//! `docs/specs/s3-compatible-storage/extending-providers.md`.

pub mod common;
pub mod dropbox;
pub mod google_drive;
pub mod onedrive;
pub mod s3;

use crate::model::Provider;
use crate::provider::{AuthMode, ConnectFlow, CredentialsSchema, ProviderFactory};
use dropbox::{DropboxConfig, DropboxFactory};
use google_drive::{GoogleDriveConfig, GoogleDriveFactory};
use onedrive::{OneDriveConfig, OneDriveFactory};
use s3::S3Factory;

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
    /// S3-compatible storage needs no server-level credentials, so it
    /// reports configured unconditionally (OQ-3: always enabled, no
    /// kill-switch).
    pub fn is_configured(&self, provider: Provider) -> bool {
        match provider {
            Provider::GoogleDrive => self.google.is_some(),
            Provider::Dropbox => self.dropbox.is_some(),
            Provider::OneDrive => self.onedrive.is_some(),
            Provider::S3Compatible => true,
        }
    }

    /// The provider's connect-flow kind — a static property of the
    /// provider, not of its configuration. Drives the `authMode` field of
    /// `GET /api/connections/available` so the frontend knows whether to
    /// render an OAuth redirect button or a credentials form.
    pub fn auth_mode(&self, provider: Provider) -> AuthMode {
        match provider {
            Provider::GoogleDrive | Provider::Dropbox | Provider::OneDrive => AuthMode::OAuth,
            Provider::S3Compatible => AuthMode::Credentials,
        }
    }

    /// The renderable credentials form for a credentials-flow provider, or
    /// `None` for OAuth providers / unconfigured providers. The frontend
    /// renders this schema generically — the `credentials` field of
    /// `GET /api/connections/available`.
    pub fn credentials_schema(&self, provider: Provider) -> Option<CredentialsSchema> {
        match self.factory_for(provider)?.connect_flow() {
            ConnectFlow::Credentials(schema) => Some(schema),
            ConnectFlow::OAuth(_) => None,
        }
    }

    /// Build a `ProviderFactory` for `provider`, or `None` if it is not
    /// configured. This is the single dispatch point over the `Provider` enum —
    /// callers use the returned trait object and never match on the provider
    /// themselves.
    pub fn factory_for(&self, provider: Provider) -> Option<Box<dyn ProviderFactory>> {
        match provider {
            Provider::GoogleDrive => self
                .google
                .clone()
                .map(|cfg| Box::new(GoogleDriveFactory::new(cfg)) as Box<dyn ProviderFactory>),
            Provider::Dropbox => self
                .dropbox
                .clone()
                .map(|cfg| Box::new(DropboxFactory::new(cfg)) as Box<dyn ProviderFactory>),
            Provider::OneDrive => self
                .onedrive
                .clone()
                .map(|cfg| Box::new(OneDriveFactory::new(cfg)) as Box<dyn ProviderFactory>),
            // Credential-based: no server-level config to gate on (OQ-3),
            // so the factory is always available.
            Provider::S3Compatible => Some(Box::new(S3Factory) as Box<dyn ProviderFactory>),
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

    /// OQ-3: S3 needs no server-level credentials, so it is always
    /// configured — even on a default (empty) registry. No kill-switch.
    #[test]
    fn s3_is_configured_even_on_an_empty_registry() {
        let reg = ProviderRegistry::default();
        assert!(reg.is_configured(Provider::S3Compatible));
    }

    /// The auth-mode table behind `GET /api/connections/available`: the
    /// three OAuth providers vs the credential-form provider.
    #[test]
    fn auth_mode_is_oauth_for_cloud_providers_credentials_for_s3() {
        let reg = ProviderRegistry::default();
        assert_eq!(reg.auth_mode(Provider::GoogleDrive), AuthMode::OAuth);
        assert_eq!(reg.auth_mode(Provider::Dropbox), AuthMode::OAuth);
        assert_eq!(reg.auth_mode(Provider::OneDrive), AuthMode::OAuth);
        assert_eq!(reg.auth_mode(Provider::S3Compatible), AuthMode::Credentials);
    }

    /// Task 005 closed the interim gap: the credential-form factory is
    /// registered, so a default (empty) registry still dispatches S3 to a
    /// real factory exposing `ConnectFlow::Credentials`.
    #[test]
    fn s3_builds_credentials_factory_on_default_registry() {
        let reg = ProviderRegistry::default();
        let factory = reg
            .factory_for(Provider::S3Compatible)
            .expect("s3 factory is always available");
        assert_eq!(factory.name(), "s3");
        match factory.connect_flow() {
            crate::provider::ConnectFlow::Credentials(schema) => {
                assert!(schema.fields.iter().any(|f| f.key == "endpoint"));
            }
            crate::provider::ConnectFlow::OAuth(_) => {
                panic!("s3 must connect via a credentials form")
            }
        }
    }

    #[test]
    fn configured_provider_is_configured_and_builds_factory() {
        let reg = ProviderRegistry::new(Some(google_cfg()), None, None);
        assert!(reg.is_configured(Provider::GoogleDrive));
        assert!(!reg.is_configured(Provider::Dropbox));
        let factory = reg
            .factory_for(Provider::GoogleDrive)
            .expect("google configured");
        assert_eq!(factory.name(), "google_drive");
        let url = match factory.connect_flow() {
            crate::provider::ConnectFlow::OAuth(flow) => {
                flow.authorization_url("https://example.com/cb", "state", "challenge")
            }
            crate::provider::ConnectFlow::Credentials(_) => {
                panic!("google_drive must connect via OAuth")
            }
        };
        assert!(url.contains("client_id=g-id"));
    }

    #[test]
    fn all_three_providers_build_factories() {
        let reg = ProviderRegistry::new(
            Some(google_cfg()),
            Some(dropbox_cfg()),
            Some(onedrive_cfg()),
        );
        for p in [Provider::GoogleDrive, Provider::Dropbox, Provider::OneDrive] {
            assert!(reg.is_configured(p), "{p:?} should be configured");
            assert!(
                reg.factory_for(p).is_some(),
                "{p:?} should produce a factory"
            );
        }
    }

    #[test]
    fn all_factories_expose_oauth_connect_flow() {
        let reg = ProviderRegistry::new(
            Some(google_cfg()),
            Some(dropbox_cfg()),
            Some(onedrive_cfg()),
        );
        for p in [Provider::GoogleDrive, Provider::Dropbox, Provider::OneDrive] {
            let factory = reg.factory_for(p).expect("configured");
            assert!(
                matches!(
                    factory.connect_flow(),
                    crate::provider::ConnectFlow::OAuth(_)
                ),
                "{p:?} must connect via OAuth"
            );
        }
    }

    /// The credentials schema is data the frontend renders generically; its
    /// JSON shape is therefore a contract. Assert the exact serialized form
    /// so adding a field is a deliberate, visible change.
    #[test]
    fn credentials_schema_serializes_snake_case() {
        let schema = crate::provider::CredentialsSchema {
            fields: vec![crate::provider::CredentialField {
                key: "endpoint".into(),
                label: "Endpoint".into(),
                secret: false,
                placeholder: Some("https://…".into()),
            }],
        };
        let json = serde_json::to_value(&schema).unwrap();
        assert_eq!(
            json,
            serde_json::json!({
                "fields": [{
                    "key": "endpoint",
                    "label": "Endpoint",
                    "secret": false,
                    "placeholder": "https://…",
                }]
            })
        );
    }

    /// The default `verify` rejects static credentials for OAuth-only
    /// providers before any network call.
    #[tokio::test]
    async fn verify_rejects_non_oauth_credential() {
        let reg = ProviderRegistry::new(Some(google_cfg()), None, None);
        let factory = reg.factory_for(Provider::GoogleDrive).unwrap();
        let err = factory
            .verify(&crate::crypto::Credential::S3(
                crate::crypto::S3Credentials {
                    endpoint: "https://e".into(),
                    region: "auto".into(),
                    bucket: "b".into(),
                    access_key_id: "k".into(),
                    secret_access_key: "s".into(),
                    prefix: None,
                },
            ))
            .await
            .unwrap_err();
        assert!(matches!(err, crate::provider::ProviderError::Other(_)));
    }
}
