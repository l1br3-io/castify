pub mod codec_support;
pub mod crypto;
pub mod model;
pub mod oauth;
pub mod probe;
pub mod provider;
pub mod providers;
pub mod repository;
pub mod scanner;

pub use crypto::{decrypt, encrypt, TokenBundle, TokenKey};
pub use model::{
    DiscoveredSubtitle, DiscoveredVideo, ListPage, NewConnection, NewVideo, PlaybackProgress,
    Provider, ProviderConnection, ScanState, ScanStatus, SubtitleTrack, VideoCacheEntry,
    VideoDetail, VideoFilter, VideoPage, VideoSort, VideoSource, VideoSummary,
};
pub use oauth::{generate_state, redirect_uri, OAuthStateEntry, OAuthStateStore, PkceChallenge};
pub use provider::{
    BodyStream, ProviderError, ProviderFactory, ProviderResult, StreamResponse, StreamUrl,
    ThumbnailData,
};
pub use providers::dropbox::{DropboxClient, DropboxConfig, DropboxUserInfo};
pub use providers::google_drive::{GoogleDriveClient, GoogleDriveConfig, GoogleUserInfo};
pub use providers::onedrive::{OneDriveClient, OneDriveConfig, OneDriveUserInfo};
pub use providers::ProviderRegistry;
pub use repository::{
    CatalogError, CatalogRepository, CatalogResult, FolderCount, ProbeStats, VideoStreamInfo,
    VideoThumbnailInfo,
};
