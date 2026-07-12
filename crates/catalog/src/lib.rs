pub mod crypto;
pub mod model;
pub mod oauth;
pub mod provider;
pub mod providers;
pub mod repository;
pub mod scanner;

pub use crypto::{decrypt, encrypt, TokenBundle, TokenKey};
pub use model::{
    DiscoveredVideo, ListPage, NewConnection, NewVideo, Provider, ProviderConnection, ScanState,
    ScanStatus, VideoFilter, VideoPage, VideoSort, VideoSource, VideoSummary,
};
pub use oauth::{generate_state, redirect_uri, OAuthStateEntry, OAuthStateStore, PkceChallenge};
pub use provider::{ProviderError, ProviderFactory, ProviderResult, ThumbnailData};
pub use providers::dropbox::{DropboxClient, DropboxConfig, DropboxUserInfo};
pub use providers::google_drive::{GoogleDriveClient, GoogleDriveConfig, GoogleUserInfo};
pub use providers::onedrive::{OneDriveClient, OneDriveConfig, OneDriveUserInfo};
pub use providers::ProviderRegistry;
pub use repository::{
    CatalogError, CatalogRepository, CatalogResult, FolderCount, VideoThumbnailInfo,
};
