use crate::session::{iso_in, iso_now, SessionId};
use crate::{AuthError, AuthResult, NewOwner, Owner};
use sqlx::SqlitePool;
use uuid::Uuid;
const DEFAULT_SESSION_TTL_DAYS: i64 = 30;

/// Repository abstraction over auth-related tables. Holds no state of its own;
/// methods take the pool so callers can compose transactions later.
#[derive(Clone)]
pub struct AuthRepository {
    pool: SqlitePool,
}

impl AuthRepository {
    pub fn new(pool: SqlitePool) -> Self {
        Self { pool }
    }

    pub async fn owner_count(&self) -> AuthResult<i64> {
        let count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM owners")
            .fetch_one(&self.pool)
            .await?;
        Ok(count)
    }

    pub async fn owner_exists(&self) -> AuthResult<bool> {
        Ok(self.owner_count().await? > 0)
    }

    pub async fn create_owner(&self, new_owner: &NewOwner) -> AuthResult<Owner> {
        let created_at = iso_now();
        sqlx::query("INSERT INTO owners (id, created_at, display_name) VALUES (?, ?, ?)")
            .bind(new_owner.id.to_string())
            .bind(&created_at)
            .bind(new_owner.display_name.as_deref())
            .execute(&self.pool)
            .await?;
        Ok(Owner {
            id: new_owner.id,
            display_name: new_owner.display_name.clone(),
        })
    }

    pub async fn fetch_owner(&self) -> AuthResult<Owner> {
        let row = sqlx::query("SELECT id, display_name FROM owners LIMIT 1")
            .fetch_optional(&self.pool)
            .await?;
        match row {
            None => Err(AuthError::NoOwner),
            Some(row) => Self::row_to_owner(&row),
        }
    }

    /// Look up the owner by id. Returns `AuthError::NoOwner` if no row matches.
    /// Used to resolve the owner from a validated session in `GET /api/session`.
    pub async fn fetch_owner_by_id(&self, owner_id: &Uuid) -> AuthResult<Owner> {
        let row = sqlx::query("SELECT id, display_name FROM owners WHERE id = ?")
            .bind(owner_id.to_string())
            .fetch_optional(&self.pool)
            .await?;
        match row {
            None => Err(AuthError::NoOwner),
            Some(row) => Self::row_to_owner(&row),
        }
    }

    fn row_to_owner(row: &sqlx::sqlite::SqliteRow) -> AuthResult<Owner> {
        let id_str: String = sqlx::Row::get(row, "id");
        let display_name: Option<String> = sqlx::Row::get(row, "display_name");
        let id = Uuid::parse_str(&id_str)
            .map_err(|e| AuthError::Internal(anyhow::anyhow!("owner id not a uuid: {e}")))?;
        Ok(Owner { id, display_name })
    }

    pub async fn set_password(&self, owner_id: &Uuid, phc: &str) -> AuthResult<()> {
        let now = iso_now();
        let result = sqlx::query(
            "INSERT INTO password_credentials (owner_id, password_hash, created_at, updated_at) \
             VALUES (?, ?, ?, ?) \
             ON CONFLICT(owner_id) DO UPDATE SET password_hash = excluded.password_hash, updated_at = excluded.updated_at",
        )
        .bind(owner_id.to_string())
        .bind(phc)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        if result.rows_affected() == 0 {
            return Err(AuthError::RowCount("password_credentials upsert".into()));
        }
        Ok(())
    }

    pub async fn fetch_password_hash(&self, owner_id: &Uuid) -> AuthResult<Option<String>> {
        let row = sqlx::query_scalar::<_, Option<String>>(
            "SELECT password_hash FROM password_credentials WHERE owner_id = ?",
        )
        .bind(owner_id.to_string())
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.flatten())
    }

    pub async fn create_session(
        &self,
        owner_id: &Uuid,
        ttl_days: Option<i64>,
    ) -> AuthResult<SessionId> {
        let id = SessionId::generate();
        let now = iso_now();
        let expires = iso_in(ttl_days.unwrap_or(DEFAULT_SESSION_TTL_DAYS));
        sqlx::query(
            "INSERT INTO sessions (id, owner_id, created_at, expires_at, last_seen_at) \
             VALUES (?, ?, ?, ?, ?)",
        )
        .bind(&id.0)
        .bind(owner_id.to_string())
        .bind(&now)
        .bind(&expires)
        .bind(&now)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn validate_session(&self, session_id: &SessionId) -> AuthResult<Uuid> {
        let row = sqlx::query("SELECT owner_id, expires_at FROM sessions WHERE id = ?")
            .bind(&session_id.0)
            .fetch_optional(&self.pool)
            .await?;
        let row = row.ok_or(AuthError::InvalidSession)?;
        let owner_id_str: String = sqlx::Row::get(&row, "owner_id");
        let expires_at: String = sqlx::Row::get(&row, "expires_at");
        let now = chrono::Utc::now();
        let expires = chrono::DateTime::parse_from_rfc3339(&expires_at)
            .map_err(|e| AuthError::Internal(anyhow::anyhow!("expiry parse error: {e}")))?
            .with_timezone(&chrono::Utc);
        if now > expires {
            return Err(AuthError::SessionExpired);
        }
        let owner_id = Uuid::parse_str(&owner_id_str)
            .map_err(|e| AuthError::Internal(anyhow::anyhow!("owner id not a uuid: {e}")))?;
        Ok(owner_id)
    }

    pub async fn delete_session(&self, session_id: &SessionId) -> AuthResult<()> {
        sqlx::query("DELETE FROM sessions WHERE id = ?")
            .bind(&session_id.0)
            .execute(&self.pool)
            .await?;
        Ok(())
    }
}
