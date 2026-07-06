#[derive(Debug, thiserror::Error)]
pub enum StorageError {
    #[error("database error: {0}")]
    Sqlx(#[from] sqlx::Error),
    #[error("migration error: {0}")]
    Migrate(#[from] sqlx::migrate::MigrateError),
    #[error("database path is not valid UTF-8")]
    NonUtf8Path,
    #[error("database path is not a file: {0}")]
    InvalidPath(String),
}

pub type StorageResult<T> = Result<T, StorageError>;
