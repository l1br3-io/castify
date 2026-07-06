// Shared DTO types for `/api/session` and `/api/setup` responses.
// These mirror the Rust DTOs in `crates/api/src/routes/dto.rs` (OwnerDto) and
// the `{owner: OwnerDto}` envelope used by setup/session/login responses.

export interface OwnerDto {
  id: string;
  display_name: string | null;
}

export interface OwnerEnvelope {
  owner: OwnerDto;
}
